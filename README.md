# Violet task runner

## Installation
Install Violet using your preferred package manager: 
```shell
$ bun add -D -E violet.ts
$ pnpm add -D -E violet.ts
$ deno add -D npm:violet.ts
$ npm i -D -E violet.ts 
$ yarn add -D -E violet.ts
```

## Overview
Violet is a lightweight TypeScript task runner designed for simplicity and clarity.
It provides a fluent interface for defining and executing build, test, or automation tasks.

## Key Features
- Executes one task per command.
- Fluent, chainable API.
- Automatically detects violet.ts or Violet.ts as the task definition file.

## Basic Example
```typescript
import type { Violet } from "violet.ts"

// The default exported function defines all tasks.
export default function builder(v: Violet) {
    v.addTask("hello")
        .log("Hello world")
        .exec("echo", "Hello world")
}
```
Run the task with: 
```shell
violet hello
```

## Task dependencies
Tasks can depend on other tasks. Dependencies are executed step by step before the dependent task.

```typescript
v.addTask("test")
    .log("Running Go and TypeScript tests")
    .exec("go", "test", "./...")
    .exec("npm", "run", "test")

v.addTask("build")
    .deps("test")
    .log("Building Go and TypeScript")
    .exec("go", "build", "./cmd/app")
    .exec("npm", "run", "build")
```

## Run TypeScript functions
Violet allows running both synchronous and asynchronous functions within tasks.
### Sequential Execution
`run()` executes functions one by one, in the order they are declared.
```typescript
 
v.addTask("build")
    .run(() => console.log("Step 1"))
    .run(() => console.log("Step 2"))
    .run(
        () => console.log("Step 3")
        () => console.log("Step 4")
    )
```
### Parallel Execution
`parallel()` executes functions concurrently.

``` typescript
v.addTask("task")
    .log("Running tasks in parallel")
    .parallel(
        async () => {
            console.log("Running unit tests");
            await new Promise(r => setTimeout(r, 300));
            console.log("Tests finished");
        },
        async () => {
            console.log("Building TypeScript project");
            await new Promise(r => setTimeout(r, 300));
            console.log("Build finished");
        }
    );
```

## Using task context
Each task maintains its own context — an object that persists between `run()` and `parallel()` calls.
This allows sharing state.
- Both `run()` and `parallel()` receive the current context as an argument.
- Returning an object replaces the current context completely.
- It is recommended to use clear and explicit context structures.

```typescript
v.addTask("context")
    .run((ctx) => { return { flag: true } })
    .run((ctx) => { console.log(ctx.flag) })
```

## Executing shell commands
`exec()` executes shell commands synchronously in sequence.

```typescript
v.addTask("build")
    .exec("rm", "-rf", "dist")
    .exec("npm", "run", "build")
```

## Logging
Use `.log()` for standard messages, `.warn()` for warnings and `error()` for errors.

```typescript
v.addTask("build")
    .log("Starting build process")
    .warn("Build directory will be cleared")
    .error("Error in build process")
```
