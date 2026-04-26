---
title: Rust 方法解析的暗流
description: '深入分析 Rust 方法解析机制：为什么在 &T 上调用 .clone() 有时返回 T，有时返回 &T？从编译器候选类型构建到 Autoref 最小化的完整决策树。'
publishDate: 2026-03-21
tags:
  - Rust
  - 方法解析
  - Clone
  - 自动解引用
  - 类型系统
language: 'zh-CN'
comment: true
---

> 当你在 `&T` 上调用 `.clone()`，你真的知道会发生什么吗？

## 引子：两段代码，两个世界

先看这两段看似相似的代码：

```rust
// 第一段：T 有 Clone 约束
fn deep_clone<T: Clone>(value: &T) {
    let cloned: T = value.clone();
    // cloned 是 T，深拷贝
}

// 第二段：T 无约束
fn shallow_clone<T>(value: &T) {
    let cloned: &T = value.clone();
    // cloned 是 &T，浅拷贝（只复制指针）
}
```

问题来了：**同样是 `value.clone()`，为什么一个返回 `T`，一个返回 `&T`？**

答案藏在 Rust 的方法解析机制里——这不是简单的"类型推断"，而是编译器在**候选方法构建**、**Autoref 最小化**、**自动解引用**之间的精密博弈。

---

## 第一层：现象分析——深拷贝 vs 浅拷贝

### 发生了什么？

| 代码 | T 的约束 | clone() 的接收者 | 返回类型 | 实际行为 |
|------|---------|-----------------|---------|---------|
| 第一段 | `T: Clone` | `T`（通过自动解引用）| `T` | **深拷贝**：创建全新的 T 值 |
| 第二段 | 无 | `&T`（引用本身）| `&T` | **浅拷贝**：复制指针，指向同一块内存 |

### 验证浅拷贝

```rust
fn shallow_clone<T>(value: &T) {
    let cloned: &T = value.clone();
    // 验证：value 和 cloned 指向同一地址
    assert_eq!(value as *const T, cloned as *const T);
}
```

这个设计很合理：
- 当你明确要求 `T: Clone`，编译器知道你**需要值的克隆**
- 当你没有约束，编译器退而求其次——**至少可以克隆引用**（零成本的指针复制）

但为什么第一段代码调的是 `T::clone`，第二段调的是 `&T::clone`？

---

## 第二层：方法解析机制——Rust Reference 怎么说

Rust 的方法调用不是简单的"找到名字匹配就调用"。根据 [Rust Reference - Method Call Expressions](https://doc.rust-lang.org/reference/expressions/method-call-expr.html#r-expr.method.autoref-deref)，编译器执行以下**精确过程**：

### Step 1: 构建候选接收者类型列表（核心算法）

这是整个方法解析的基石。编译器按以下顺序构建列表：

**① 重复解引用原始类型，每次将遇到的类型加入列表**

对于接收者类型 `Box<[i32; 2]>`：
```
Box<[i32; 2]>           ← 原始类型
[i32; 2]                ← 解引用 #1（Deref）
```

**② 最后尝试一次 Unsized Coercion**

```
[i32]                   ← [i32; 2] → [i32]（Unsized Coercion）
```

**③ 对于列表中的每个类型 T，立即在其后添加 &T 和 &mut T**

最终得到**完整候选列表**：

```
Box<[i32; 2]>           ← 原始类型
&Box<[i32; 2]>          ← autoref
&mut Box<[i32; 2]>      ← autoref mut
[i32; 2]                ← 解引用 #1
&[i32; 2]               ← autoref
&mut [i32; 2]           ← autoref mut
[i32]                   ← unsized coercion
&[i32]                  ← autoref
&mut [i32]              ← autoref mut ← 最终匹配！
```

> 这就是 Reference 中给出的官方示例。当你的接收者是 `Box<[i32; 2]>` 时，编译器会尝试**整整 9 种候选类型**，直到找到匹配的方法。

### Step 2: 按顺序搜索可见方法

对于每个候选类型 `T`，编译器按以下优先级搜索方法：

1. **T 的固有方法**（直接在 `T` 上实现的方法）
2. **T 实现的所有可见 trait 提供的方法**
   - 如果 `T` 是类型参数，优先查找 trait bounds 上的方法
   - 然后查找作用域内所有其他方法

> ⚠️ **关键细节**：查找是按候选列表**顺序**进行的。这意味着前面的类型会"遮挡"后面类型的方法，即使后面类型的方法"更精确"。

### Step 3: 处理多候选冲突

如果搜索结果是**多个可能的候选方法**，编译器报错，要求显式转换接收者类型。

**一个令人惊讶的例子**（来自 Rust Reference）：

```rust
struct Foo {}

trait Bar {
    fn bar(&self);
}

impl Foo {
    fn bar(&mut self) {
        println!("In struct impl!");
    }
}

impl Bar for Foo {
    fn bar(&self) {
        println!("In trait impl!");
    }
}

fn main() {
    let mut f = Foo{};
    f.bar();  // 输出 "In trait impl!"
}
```

为什么调用的是 trait 方法，而不是 `&mut self` 的固有方法？

因为 `&self` 方法在候选类型 `&Foo` 上被优先查找，而 `&mut self` 方法需要在 `&mut Foo` 上查找。`&Foo` 在候选列表中排在 `&mut Foo` 之前，所以 trait 方法先被找到。

### Step 4: 应用到我们的 Clone 问题

回到最初的问题：`&T` 上的 `.clone()`。

**候选类型构建**：
```
&T              ← 原始类型
&&T             ← autoref
&mut &T         ← autoref mut
T               ← 解引用（如果 T: Deref）
&T              ← autoref（解引用后）
...
```

**第一段代码（T: Clone）**：

| 候选类型 | 搜索到的 clone 方法 | 期望接收者 | 匹配？ |
|---------|------------------|-----------|-------|
| `&T` | `&T::clone`（blanket impl） | `&&T` | 需要 autoref ❌ |
| `T` | `T::clone` | `&T` | 完美匹配 ✅ |

编译器选择 `T::clone`，因为它不需要额外的自动引用。

**第二段代码（无 Clone 约束）**：

| 候选类型 | 搜索到的 clone 方法 | 原因 |
|---------|------------------|------|
| `&T` | `&T::clone`（唯一可用） | `T` 未实现 Clone，`T::clone` 不存在 |

编译器别无选择，只能使用 `&T::clone`，这需要一次 autoref 将 `&T` 转为 `&&T`。

---

## 第三层：Autoref 与解引用的精确语义

理解了候选列表的构建，我们深入探讨**为什么**编译器这样选择。

### 类型强制（Coercion）的发生位置

根据 [Rust Reference - Type Coercions](https://doc.rust-lang.org/reference/type-coercions.html)，类型强制只能发生在特定的**强制位置（Coercion Sites）**：

- `let` 语句（显式类型标注时）
- `static` / `const` 声明
- **函数调用参数**（实际参数强制为形参类型）
- 结构体/联合体/枚举字段实例化
- 函数返回值

> 注意：方法调用的接收者（`self` 参数）**不是普通的强制位置**！它有自己独立的解析规则（即我们上面说的候选列表机制）。

### Unsized Coercion 的完整规则

Reference 定义了以下 Unsized Coercion（无大小类型强制）：

| 源类型 | 目标类型 | 说明 |
|-------|---------|------|
| `[T; n]` | `[T]` | 定长数组 → 切片 |
| `T` | `dyn Trait` | 具体类型 → trait 对象（当 T: Trait + Sized）|
| `dyn Trait` | `dyn SuperTrait` | trait 对象 → 父 trait |
| `Foo<..., T, ...>` | `Foo<..., U, ...>` | 结构体最后一个字段的 Unsize |

**关键特性**：Unsized Coercion 可以在方法解析的候选列表构建中发生（作为最后一步），但**不能**在普通函数参数强制中发生——除非通过 `&T` / `Box<T>` 等指针类型。

---

## 第四层：函数参数强制——Deref 与 Unsize 的协同

第三层讲的是**方法调用**的解析机制。但 Rust 还有另一套机制处理**函数参数**的类型转换，那就是**强制位置（Coercion Sites）**规则。

这里的关键区别在于：
- `receiver.method()` —— 使用方法解析的候选列表机制
- `func(&mut value)` —— 使用 Coercion Site 的强制规则（包括 Deref Coercion 和 Unsized Coercion）

### 一个神奇的例子

```rust
fn process(slice: &mut [i32]) {
    println!("Got slice with {} elements", slice.len());
}

fn main() {
    let mut arr: Box<[i32; 2]> = Box::new([1, 2]);
    process(&mut arr);  // 这居然能编译？！
}
```

问：`Box<[i32; 2]>` 是怎么变成 `&mut [i32]` 的？

### 完整转换链条

Rust 编译器在这个函数调用中执行了**两次连续的强制转换**：

```
&mut Box<[i32; 2]>
    ↓ DerefMut Coercion（强制位置规则）
&mut [i32; 2]
    ↓ Unsized Coercion（TyCtor 规则）
&mut [i32]
    ↓ 完美匹配目标类型
```

### 第一步：DerefMut Coercion（函数参数强制）

根据 Reference，在**函数调用参数**这个 Coercion Site，`&mut T` 可以强制为 `&mut U`，如果 `T: DerefMut<Target = U>`。

`Box<[i32; 2]>` 实现了 `DerefMut<Target = [i32; 2]>`，所以：

```rust
impl<T: ?Sized, A: Allocator> DerefMut for Box<T, A> {
    fn deref_mut(&mut self) -> &mut T { &mut **self }
}
```

这导致 `&mut Box<[i32; 2]>` 被强制为 `&mut [i32; 2]`。

### 第二步：Unsized Coercion

现在我们有 `&mut [i32; 2]`，需要变成 `&mut [i32]`。

根据 Reference 的 **TyCtor 规则**：

> `TyCtor<T>` to `TyCtor<U>`，其中 `TyCtor` 是 `&T`、`&mut T`、`*const T`、`*mut T`、`Box<T>` 之一，且 `T` 可以通过 Unsized Coercion 转为 `U`。

而 `[i32; 2]` 到 `[i32]` 正是一个内置的 Unsized Coercion！

```rust
// 内置实现（伪代码）
impl<T, const N: usize> Unsize<[T]> for [T; N] {}
```

所以编译器执行：
- `&mut [i32; 2]` → `&mut [i32]`（通过 Unsize trait）

### 第三步：匹配函数参数

最终 `&mut [i32]` 完美匹配 `process` 函数的参数类型。

### 更复杂的链条

```rust
fn demo(s: &str) {}

fn main() {
    let s: Box<String> = Box::new("hello".to_string());
    demo(&s);  // 编译通过！
}
```

转换链条：

```
&Box<String>
    ↓ Deref: Box<String> → String
&String
    ↓ Deref: String → str
&str
```

这里用了两次 Deref Coercion（没有 Unsized Coercion），因为 `String: Deref<Target=str>`。

### 关键区分：Deref vs Unsize

| 特性 | Deref Coercion | Unsized Coercion |
|------|---------------|------------------|
| 触发条件 | `T: Deref<Target=U>` | `T: Unsize<U>`（内置）|
| 指针容器 | 作用于 `Box<T>`、`&T`、`&mut T` | 同样作用于这些容器 |
| 典型转换 | `Box<String>` → `&str` | `[T; N]` → `[T]` |
| 运行时成本 | 无（只是解引用） | 无（胖指针构造）|
| Trait 稳定性 | Deref 稳定 | Unsize 不稳定（但行为稳定）|

---

## 实战：构建一个"万能接收器"

理解了这些机制，你可以写出看似"魔法"的 API：

```rust
/// 接受任何可以转换为 &mut [i32] 的类型
fn sum_all(data: &mut [i32]) -> i32 {
    data.iter().sum()
}

fn main() {
    // 1. 直接传切片
    let mut slice = [1, 2, 3];
    println!("{}", sum_all(&mut slice));  // 6
    
    // 2. 传 Box<[i32; N]>（触发 DerefMut + Unsize）
    let mut boxed: Box<[i32; 3]> = Box::new([4, 5, 6]);
    println!("{}", sum_all(&mut boxed));  // 15
    
    // 3. 传 Vec<i32>（触发 DerefMut）
    let mut vec = vec![7, 8, 9];
    println!("{}", sum_all(&mut vec));  // 24
}
```

这背后的机制正是：**Deref Coercion + Unsized Coercion + 方法解析**的协同工作。

对于 `sum_all(&mut boxed)`：
```
&mut Box<[i32; 3]>
    ↓ DerefMut: Box → [i32; 3]
&mut [i32; 3]
    ↓ Unsize: [i32; 3] → [i32]
&mut [i32]  ✅
```

对于 `sum_all(&mut vec)`：
```
&mut Vec<i32>
    ↓ DerefMut: Vec → [i32]
&mut [i32]  ✅
```

---

## 总结：完整的方法解析与强制决策树

### 方法调用解析流程

当你在 `receiver.method()` 上调用方法时：

```
1. 构建候选接收者类型列表
   ├── 重复解引用原始类型，每次加入列表
   ├── 最后尝试 Unsized Coercion，加入结果
   └── 对于列表中每个 T，立即追加 &T 和 &mut T

2. 按顺序搜索可见方法
   ├── T 的固有方法（优先）
   └── T 实现的 trait 方法

3. 处理冲突
   ├── 单候选：选择该方法
   └── 多候选：编译错误（需显式转换）
```

### 函数参数强制流程

当实参需要匹配形参类型时：

```
1. 尝试 Deref/DerefMut Coercion
   （如果实参是 &T/&mut T/Box<T> 且 T: Deref<Target=U>）

2. 尝试 Unsized Coercion（TyCtor 规则）
   （如果涉及 [T;N]→[T] 或具体类型→dyn Trait）

3. 其他标准强制（子类型、指针转换等）
```

### 关键洞察速查表

| 场景 | 编译器行为 | 所属机制 |
|------|-----------|---------|
| `value.clone()` on `&T` where `T: Clone` | 选择 `T::clone`（0 次 autoref）| 方法解析 |
| `value.clone()` on `&T` where `T` 无 Clone | 选择 `&T::clone`（1 次 autoref）| 方法解析 |
| `Box<[i32; N]>` → `&mut [i32]` | DerefMut + Unsize 两次强制 | 函数参数强制 |
| `Box<String>` → `&str` | 两次 Deref 强制 | 函数参数强制 |
| `[i32; 2]` → `[i32]` | Unsized Coercion（编译期胖指针构造）| 两种场景都可能 |
| 候选列表顺序 | 影响方法解析优先级（前面的遮挡后面的）| 方法解析特有 |

---

## 延伸阅读

- [Rust Reference: Method Call Expressions](https://doc.rust-lang.org/reference/expressions/method-call-expr.html)
- [Rust Reference: Unsized Coercions](https://doc.rust-lang.org/reference/type-coercions.html#unsized-coercions)
- [The Rust Programming Language: Deref Coercion](https://doc.rust-lang.org/book/ch15-02-deref.html)

---

*整理自 2026-03-20 技术讨论*
