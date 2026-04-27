---
title: 在 RISC-V 开发板上部署 Vaultwarden：从零到 HTTPS 的完整踩坑实录
description: '将密码管理器 Vaultwarden 部署到 LicheePi 4A（RISC-V64）开发板上，通过 Tailscale 内网 HTTPS 访问。记录从交叉编译、Docker 构建到生产加固的 7 个真实踩坑过程。'
publishDate: 2026-04-26
tags:
  - RISC-V
  - Vaultwarden
  - Docker
  - Rust
  - Tailscale
  - 交叉编译
  - 自托管
  - 密码管理器
language: 'zh-CN'
comment: true
---

> 背景：想把密码管理器 Vaultwarden 部署到手边的 LicheePi 4A（RISC-V64）开发板上，通过 Tailscale 内网 HTTPS 访问，实现零信任的私有密码管理。
>
> 整个过程从调研到跑通，历时一个下午，踩了若干坑。本文把调研、编译、部署、踩坑的完整过程记录下来，供同样想在 RISC-V 板子上折腾自托管服务的同学参考。

## 目录

1. [方案选型](#方案选型)
2. [可行性调研](#可行性调研)
3. [环境准备](#环境准备)
4. [交叉编译](#交叉编译)
5. [踩坑记录](#踩坑记录)
6. [远程部署](#远程部署)
7. [Tailscale HTTPS 配置](#tailscale-https-配置)
8. [生产环境加固](#生产环境加固)
9. [踩坑速查表](#踩坑速查表)
10. [文件清单](#文件清单)

---

## 1. 方案选型

### 为什么不在板子上直接编译？

LicheePi 4A 只有 16GB 内存，RISC-V 的 Rust 编译本身就慢，Vaultwarden 的 release 构建（`lto = fat`, `codegen-units = 1`）峰值内存需求 7GB+。在板子上编译大概率 OOM，即使成功也要数小时。如果想尝试的话也可以，~~毕竟在软件所实习的时候在荔枝派上编译过node~~，不过本文聚焦于交叉编译的可能性和自动化CI，如果对这块感兴趣建议看下去。

### 为什么不用 QEMU/buildx 直接构建 riscv64 镜像？

QEMU 用户态模拟编译 Rust 慢一个数量级，且 buildx 构建的缓存管理复杂。

### 最终路线

```
x86 Linux 宿主机
  └── Docker 容器（rust-musl-cross）
        └── 交叉编译 → riscv64 静态二进制

scp 二进制

LicheePi 4A (RevyOS)
  └── 本地构建 Docker 运行时镜像（debian:trixie-slim）
        └── SQLite 数据卷
              └── Tailscale Serve → HTTPS
```

**核心优势**：

- 不污染 x86 宿主机环境（全在 Docker 内完成）
- 不在板子上编译 Rust
- 静态二进制无外部依赖，运行时镜像干净
- Tailscale 内网暴露，零端口开放

---

## 2. 可行性调研

在动手之前，我逐项验证了方案中的每个技术环节。

### 2.1 交叉编译工具链

选用 `messense/rust-musl-cross:riscv64gc-musl` Docker 镜像，它预装了：

- Rust stable 工具链 + `riscv64gc-unknown-linux-musl` target
- `riscv64-linux-musl-gcc` 交叉编译器
- musl libc sysroot

**已知风险**：该镜像的 GCC 版本偏旧，在编译 vendored OpenSSL 时可能触发 `unsupported ISA subset 'z'` 错误。这是 `rust-cross/rust-musl-cross` 的 Issue #206，社区建议升级到 GCC 12.4.0+。

**实际结果**：在本次编译中未触发该错误，OpenSSL 顺利通过。但这是一个需要提前调研的风险点。

### 2.2 关键原生依赖（C/ASM）

Vaultwarden 并非纯 Rust，以下 crate 包含 C/ASM 代码：

| Crate | 版本 | RISC-V 风险 |
|-------|------|-------------|
| `ring` | 0.17.14 | **中高风险**。0.17.x 重构了构建逻辑，但 riscv64-musl 不在其 CI 验证目标中。实际上编译通过了。 |
| `openssl-sys` (vendored) | 0.9.114 | **中高风险**。依赖 GCC 版本，见上。实际通过。 |
| `libsqlite3-sys` (bundled) | 0.36.0 | 低风险。SQLite 对 RISC-V 支持成熟。 |

### 2.3 Rust 目标平台

`riscv64gc-unknown-linux-musl` 于 Rust 1.82.0 晋升为 Tier 2 target，通过 rustup 直接分发标准库。Vaultwarden 1.35.8 要求 `rust-version = "1.93.0"`，工具链镜像内置 1.94.0，满足要求。

### 2.4 运行时基础镜像

Debian 13 "Trixie" 已于 2025-08-09 正式发布，首次官方支持 riscv64。`riscv64/debian:trixie-slim` 在 Docker Hub 持续维护，与 LicheePi 4A 的 RevyOS（基于 Debian 定制）高度兼容。

### 2.5 Tailscale Serve

Tailscale Serve 可将本地 HTTP 服务通过 tailnet 内网 HTTPS 暴露，由 Tailscale 基础设施自动终止 TLS。Bitwarden Web Vault 依赖浏览器的 Web Crypto API，要求 Secure Context（HTTPS 或 localhost），Tailscale Serve 提供的 `https://<device>.<tailnet>.ts.net` 满足此要求。

---

## 3. 环境准备

### 目录结构

```
vaultwarden-riscv64/
├── Dockerfile.builder      # x86 交叉编译环境
├── build.sh                # 一键编译脚本
├── runtime/
│   └── Dockerfile          # LicheePi 运行时镜像
└── out/                    # 编译产物（.gitignore）
    └── vaultwarden
```

### 前提条件

- x86 Linux 宿主机，Docker 已安装，8GB+ 内存（我用的是WSL）
- LicheePi 4A 运行 RevyOS，Docker 已安装（参考[在RevyOS上安装Docker](https://docs.revyos.dev/docs/desktop/revyos-use-docker/)）
- 两台设备均已加入同一 Tailscale tailnet（不是必选项目，只要两台机器能相互连接就行）

---

## 4. 交叉编译

### 4.1 构建环境 Dockerfile

```dockerfile
# Dockerfile.builder
# 备选：ghcr.io/rust-cross/rust-musl-cross:riscv64gc-musl
FROM messense/rust-musl-cross:riscv64gc-musl

RUN apt-get update && apt-get install -y \
    git make perl pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
```

### 4.2 编译脚本

```bash
#!/usr/bin/env bash
set -euo pipefail

VAULTWARDEN_VERSION="${VAULTWARDEN_VERSION:-1.35.8}"
IMAGE_NAME="${IMAGE_NAME:-vaultwarden-riscv64-builder}"

# 构建编译环境镜像
docker build -t "${IMAGE_NAME}" -f Dockerfile.builder .

# PoC：验证工具链
echo "=== PoC: verifying toolchain ==="
docker run --rm "${IMAGE_NAME}" bash -c \
  "echo 'Rust:' \$(rustc --version) && \
   echo 'Target:' \$(rustup target list --installed | grep riscv64 || echo 'NOT INSTALLED') && \
   echo 'GCC:' \$(riscv64-linux-musl-gcc --version | head -1)"
echo "=== PoC done ==="

rm -rf out
mkdir -p out

# 交叉编译
docker run --rm \
  -v "$PWD/out:/out" \
  "${IMAGE_NAME}" \
  bash -lc "
    set -euo pipefail

    git clone --depth 1 --branch ${VAULTWARDEN_VERSION} \
      https://github.com/dani-garcia/vaultwarden.git

    cd vaultwarden

    # 关键：为 rust-toolchain.toml 指定的工具链安装 target
    rustup target add riscv64gc-unknown-linux-musl

    # 关键：+crt-static 确保完全静态链接
    CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C target-feature=+crt-static' \
    cargo build --release \
      --target riscv64gc-unknown-linux-musl \
      --features sqlite,vendored_openssl

    cp target/riscv64gc-unknown-linux-musl/release/vaultwarden /out/vaultwarden
    musl-strip /out/vaultwarden || true
  "

file out/vaultwarden
echo
echo 'Expected: ELF 64-bit LSB executable, UCB RISC-V, statically linked'
```

### 4.3 执行编译

```bash
chmod +x build.sh
./build.sh
```

编译耗时约 5 分钟（取决于网络和机器性能）。预期输出：

```
out/vaultwarden: ELF 64-bit LSB executable, UCB RISC-V, RVC, double-float ABI, version 1 (GNU/Linux), statically linked, stripped
```

产物大小约 **27MB**。

---

## 5. 踩坑记录

这是我实际遇到的所有问题，按出现顺序排列。每个坑都花了我至少 15 分钟排查。

### 坑 1：`rustup update` 破坏预装 target

**现象**：`can't find crate for 'core'`

**原因**：初始版本的 `build.sh` 中包含 `rustup update stable`，意在确保 Rust 版本满足 MSRV。然而 `rustup update` 安装了新版本工具链后，原镜像预装的 `riscv64gc-unknown-linux-musl` target 绑定丢失。

**修复**：删除 `rustup update` 步骤。镜像自带 Rust 1.94.0，已满足 MSRV 1.93.0。

**教训**：不要轻易动预构建镜像的工具链。先验证版本是否满足需求，再决定是否升级。

### 坑 2：`rust-toolchain.toml` 触发隐式工具链切换

**现象**：删除 `rustup update` 后，仍然 `can't find crate for 'core'`

**原因**：Vaultwarden 的 `rust-toolchain.toml` 指定了 `channel = "1.95.0"`。当 `cd vaultwarden` 后，rustup 自动下载并切换到 1.95.0 工具链——而这个新工具链没有 riscv64 target。

**诊断过程**：

1. 在容器内手动编译 hello world → 成功
2. 在容器内用 `bash -lc` 编译 → 也成功
3. 克隆 Vaultwarden 后编译 → 失败
4. 检查发现 `rust-toolchain.toml` 的存在

**修复**：在 `cd vaultwarden` 之后，`cargo build` 之前，加入 `rustup target add riscv64gc-unknown-linux-musl`。

**教训**：编译第三方 Rust 项目时，务必检查项目根目录的 `rust-toolchain.toml` 和 `.cargo/config.toml`，它们可能覆盖你的工具链配置。

### 坑 3：动态链接而非静态链接

**现象**：编译成功，但 `file` 输出显示 `dynamically linked, interpreter /lib/ld-musl-riscv64.so.1`

**原因**：`messense/rust-musl-cross` 镜像为 MIPS 等目标设置了 `CARGO_TARGET_*_RUSTFLAGS=-C target-feature=+crt-static`，但 **没有为 riscv64 设置**。这意味着 riscv64 构建默认使用动态链接。

**影响**：动态链接 musl 的二进制在 glibc 系统（如 Debian Trixie）上无法直接运行，需要安装 musl。

**修复**：在 `cargo build` 时显式设置环境变量：

```bash
CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static" \
cargo build --release --target riscv64gc-unknown-linux-musl ...
```

**教训**：不要假设 `*-linux-musl` 目标默认静态链接。特别是第三方构建镜像，始终用 `file` 验证产物。

### 坑 4：Web Vault 缺失

**现象**：容器启动后反复崩溃重启，日志报 `Web vault is not found at 'web-vault/'`

**原因**：源码编译的 Vaultwarden 二进制 **不包含 Web 前端资源**。Web Vault 是独立的项目（`dani-garcia/bw_web_builds`），需要单独下载。

**修复**：

```bash
# 下载预构建的 Web Vault
curl -sL -o bw_web.tar.gz \
  https://github.com/dani-garcia/bw_web_builds/releases/download/v2026.3.1/bw_web_v2026.3.1.tar.gz
mkdir -p /opt/vaultwarden/web-vault
tar -xzf bw_web.tar.gz -C /opt/vaultwarden/web-vault

# 挂载到容器中
docker run ... -v /opt/vaultwarden/web-vault/web-vault:/web-vault \
  -e 'WEB_VAULT_FOLDER=/web-vault' ...
```

**注意**：tar 包解压后内容在 `web-vault/` 子目录下，挂载时路径要写对。

**教训**：Vaultwarden 的 "二进制" 和 "Web Vault" 是分离交付的。官方 Docker 镜像把它们打包在了一起，但手动构建时需要自行获取。

### 坑 5：Docker Hub 在 RISC-V 板子上连接超时

**现象**：`docker build` 时拉取 `riscv64/debian:trixie-slim` 失败，EOF 错误。

**原因**：LicheePi 4A 在国内网络环境下直连 Docker Hub 不稳定。

**修复**：配置 Docker Hub 镜像源：

```bash
echo '{"registry-mirrors":["<your-mirror-url>"]}' \
  | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

**注意**：LicheePi 的默认 shell 是 **fish**，heredoc 语法（`<< EOF`）不兼容。用 `echo '...' | sudo tee` 代替。

### 坑 6：`vaultwarden hash` 在 docker exec 中崩溃

**现象**：`sudo docker exec vaultwarden /usr/local/bin/vaultwarden hash` 报 `No such device or address`

**原因**：`docker exec` 没有分配伪终端（`-t`），密码读取调用找不到 `/dev/tty`。

**修复**：加 `-it` 参数：`sudo docker exec -it vaultwarden /usr/local/bin/vaultwarden hash`

### 坑 7：WebAuthn / Passkey 报 `rp.id` 错误

**现象**：添加 2FA passkey 时，浏览器控制台报 `Error: 'rp.id' cannot be used with the current origin`

**原因**：WebAuthn 要求 Relying Party ID 与用户访问的域名匹配。Vaultwarden 需要通过 `DOMAIN` 环境变量知道自己的外部 URL。

**修复**：在容器启动时加入 `-e 'DOMAIN=https://<device>.<tailnet>.ts.net'`。

**教训**：凡是涉及 WebAuthn / OAuth / CORS 的功能，务必设置 `DOMAIN` 环境变量。

---

## 6. 远程部署

### 6.1 传输文件

```bash
# 在 x86 宿主机上
cd vaultwarden-riscv64

# 二进制
scp out/vaultwarden debian@<licheepi-ip>:/tmp/vaultwarden

# 运行时 Dockerfile
scp runtime/Dockerfile debian@<licheepi-ip>:/tmp/Dockerfile.vaultwarden
```

如果通过 Tailscale 连接，可以用设备名代替 IP：

```bash
scp out/vaultwarden <user>@<device>:/tmp/vaultwarden
```

### 6.2 构建运行时镜像

在 LicheePi 4A 上：

```bash
mkdir -p ~/vaultwarden-image
cp /tmp/vaultwarden ~/vaultwarden-image/vaultwarden
chmod +x ~/vaultwarden-image/vaultwarden
cp /tmp/Dockerfile.vaultwarden ~/vaultwarden-image/Dockerfile
cd ~/vaultwarden-image

sudo docker build -t vaultwarden:riscv64 .
```

### 6.3 下载 Web Vault

```bash
cd /tmp
curl -sL -o bw_web.tar.gz \
  https://github.com/dani-garcia/bw_web_builds/releases/download/v2026.3.1/bw_web_v2026.3.1.tar.gz
sudo mkdir -p /opt/vaultwarden/web-vault
sudo tar -xzf bw_web.tar.gz -C /opt/vaultwarden/web-vault
```

### 6.4 启动容器

```bash
sudo mkdir -p /opt/vaultwarden/data

sudo docker run -d \
  --name vaultwarden \
  --restart unless-stopped \
  -v /opt/vaultwarden/data:/data \
  -v /opt/vaultwarden/web-vault/web-vault:/web-vault \
  -p 127.0.0.1:8000:80 \
  -e SIGNUPS_ALLOWED=false \
  -e "DOMAIN=https://<device>.<tailnet>.ts.net" \
  -e "ADMIN_TOKEN=<你的 Argon2 hash>" \
  -e "WEB_VAULT_FOLDER=/web-vault" \
  vaultwarden:riscv64
```

**关键安全措施**：`-p 127.0.0.1:8000:80` 将端口绑定到 localhost，外部无法直接访问。所有流量必须通过 Tailscale Serve 代理。

### 6.5 验证

```bash
sudo docker logs vaultwarden
# 应看到 "Rocket has launched from http://0.0.0.0:80"

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/
# 应返回 200
```

---

## 7. Tailscale HTTPS 配置

### 7.1 确认 HTTPS 证书可用

```bash
tailscale status --json | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("DNS:", d["Self"]["DNSName"])
print("HTTPS:", d.get("CertDomains", []))'
```

如果 `CertDomains` 为空，需要在 Tailscale 管理后台启用 HTTPS certificates。

### 7.2 启动 Tailscale Serve

```bash
sudo tailscale serve --bg http://127.0.0.1:8000
```

验证：

```bash
tailscale serve status
# 应显示 https://<device>.<tailnet>.ts.net/ -> proxy http://127.0.0.1:8000
```

从其他 tailnet 设备测试：

```bash
curl -sS -o /dev/null -w '%{http_code}' https://<device>.<tailnet>.ts.net/
# 应返回 200
```

### 7.3 客户端配置

在 Bitwarden 浏览器插件或 App 中：

- **Server URL**: `https://<device>.<tailnet>.ts.net`

---

## 8. 生产环境加固

### 8.1 ADMIN_TOKEN

务必使用 Argon2 hash，不要用明文：

```bash
sudo docker exec -it vaultwarden /usr/local/bin/vaultwarden hash
# 输入密码，复制输出的 $argon2id$... 字符串
```

或者用系统工具：

```bash
sudo apt install argon2
echo -n 'YOUR_PASSWORD' | argon2 "$(openssl rand -base64 16)" -id -t 2 -m 19456 -p 1 -l 32 -e
```

### 8.2 注册控制

首次使用时临时开放注册，创建完个人账户后立刻关闭：

```bash
# 临时开放
sudo docker rm -f vaultwarden
sudo docker run -d ... -e SIGNUPS_ALLOWED=true ...

# 注册完成后，改回 false
sudo docker rm -f vaultwarden
sudo docker run -d ... -e SIGNUPS_ALLOWED=false ...
```

### 8.3 备份

```bash
sudo docker stop vaultwarden
sudo tar -czf vaultwarden-backup-$(date +%F).tar.gz /opt/vaultwarden/data
sudo docker start vaultwarden
```

建议设置 cron 定时备份。

### 8.4 安全配置汇总

| 环境变量 | 值 | 说明 |
|----------|-----|------|
| `SIGNUPS_ALLOWED` | `false` | 禁止公开注册 |
| `ADMIN_TOKEN` | Argon2 hash | 管理后台认证 |
| `DOMAIN` | `https://...ts.net` | WebAuthn / 邮件链接 |
| `INVITATIONS_ALLOWED` | `false` | 禁止邀请（单人使用时） |
| `WEB_VAULT_FOLDER` | `/web-vault` | Web 前端路径 |

---

## 9. 踩坑速查表

| 症状 | 原因 | 修复 |
|------|------|------|
| `can't find crate for 'core'` | `rustup update` 破坏了预装 target | 不要 `rustup update`，先验证镜像自带版本 |
| `can't find crate for 'core'`（修复后仍然） | `rust-toolchain.toml` 切换了工具链 | `cd` 进源码目录后 `rustup target add ...` |
| `dynamically linked` | riscv64 target 没有设 `+crt-static` | `CARGO_TARGET_*_RUSTFLAGS="-C target-feature=+crt-static"` |
| `Web vault is not found` | 二进制不含前端资源 | 单独下载 `bw_web_builds` 并挂载 |
| Docker Hub EOF | 国内网络不稳定 | 配置 `registry-mirrors` |
| `No such device or address` | `docker exec` 无 TTY | 加 `-it` 参数 |
| `rp.id cannot be used with the current origin` | 缺少 `DOMAIN` 环境变量 | 设置 `DOMAIN=https://...ts.net` |
| fish shell heredoc 报错 | fish 不支持 `<<` 语法 | 用 `echo \| tee` |

---

## 10. 文件清单

以下是最终可用的完整文件，可直接复刻：

**`Dockerfile.builder`** — x86 交叉编译环境

```dockerfile
FROM messense/rust-musl-cross:riscv64gc-musl
RUN apt-get update && apt-get install -y \
    git make perl pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
```

**`build.sh`** — 一键编译（含踩坑修复）

```bash
#!/usr/bin/env bash
set -euo pipefail

VAULTWARDEN_VERSION="${VAULTWARDEN_VERSION:-1.35.8}"
IMAGE_NAME="${IMAGE_NAME:-vaultwarden-riscv64-builder}"

docker build -t "${IMAGE_NAME}" -f Dockerfile.builder .

docker run --rm \
  -v "$PWD/out:/out" \
  "${IMAGE_NAME}" \
  bash -lc "
    set -euo pipefail

    git clone --depth 1 --branch ${VAULTWARDEN_VERSION} \
      https://github.com/dani-garcia/vaultwarden.git
    cd vaultwarden

    # 修复坑 2：为新工具链安装 target
    rustup target add riscv64gc-unknown-linux-musl

    # 修复坑 3：显式启用静态链接
    CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C target-feature=+crt-static' \
    cargo build --release \
      --target riscv64gc-unknown-linux-musl \
      --features sqlite,vendored_openssl

    cp target/riscv64gc-unknown-linux-musl/release/vaultwarden /out/vaultwarden
    musl-strip /out/vaultwarden || true
  "
```

**`runtime/Dockerfile`** — 板上运行时镜像

```dockerfile
FROM riscv64/debian:trixie-slim
RUN apt-get update && apt-get install -y \
    ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY vaultwarden /usr/local/bin/vaultwarden
ENV ROCKET_ADDRESS=0.0.0.0
ENV ROCKET_PORT=80
ENV DATA_FOLDER=/data
ENV DATABASE_URL=/data/db.sqlite3
VOLUME ["/data"]
EXPOSE 80
CMD ["/usr/local/bin/vaultwarden"]
```

---

## 总结

在 RISC-V 开发板上部署 Rust 项目，最大的挑战不是 Rust 本身，而是交叉编译工具链的配置。预构建镜像的版本、项目自身的 `rust-toolchain.toml`、链接方式的差异——这些细节叠加在一起，让 "编译一个二进制" 变成了一次对工具链的深度排查。

踩了 7 个坑之后，最终方案其实很简洁：一个 27MB 的静态二进制，一个轻量 Debian 容器，一条 Tailscale Serve 命令。所有复杂性都被封装在构建阶段，运行时几乎零配置。

如果这篇文章帮你省了哪怕一个小时的排查时间，那它就值了。

---

_本文基于 Vaultwarden 1.35.8 + Rust 1.95.0 + LicheePi 4A (RevyOS) 实际部署经验撰写。_
