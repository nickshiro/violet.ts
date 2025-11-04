#!/usr/bin/env node
import { exec } from "node:child_process";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";

/**
 * Context object passed through task execution chain.
 * Tasks can read from and modify this context.
 */
export interface Ctx {
	[key: string]: any;
}

/**
 * Available log levels for controlling output verbosity.
 */
export type LogLevel = "none" | "error" | "warn" | "log";

/**
 * A fluent builder interface for constructing tasks in a task runner.
 * Tasks are composed of dependencies, sequential actions, parallel actions,
 * shell commands, and logging statements.
 *
 * @example
 * violet.addTask('build')
 *   .dep('clean')
 *   .run(async (ctx) => { ctx.built = true; return ctx; })
 *   .exec('tsc')
 *   .log('Build complete');
 */
export interface TaskBuilder {
	/**
	 * Declares dependencies on other named tasks.
	 * These tasks must complete successfully before this task runs.
	 *
	 * @param tasks - One or more task names that must run first.
	 * @returns The same TaskBuilder instance for method chaining.
	 */
	dep: (...tasks: string[]) => TaskBuilder;

	/**
	 * Adds sequential actions to the task.
	 * Each function receives the current context and may return a new context object
	 * or `undefined` (in which case the context is passed through unchanged).
	 *
	 * Functions are executed in order. If a function returns a Promise, it is awaited.
	 *
	 * @param fns - Functions to execute sequentially.
	 * @returns The same TaskBuilder instance for method chaining.
	 */
	run: (
		...fns: Array<(ctx: Ctx) => Promise<Ctx | void> | (Ctx | void)>
	) => TaskBuilder;

	/**
	 * Adds actions to be executed in parallel.
	 * All functions are started concurrently. The task waits for all to complete.
	 * The final context is the result of the last sequential operation
	 * (parallel branches do not merge context by default).
	 *
	 * @param fns - Functions to execute in parallel.
	 * @returns The same TaskBuilder instance for method chaining.
	 */
	parallel: (
		...fns: Array<(ctx: Ctx) => Promise<Ctx | void> | (Ctx | void)>
	) => TaskBuilder;

	/**
	 * Executes a shell command.
	 * The command is run in the system shell (e.g., `sh -c` on Unix, `cmd /c` on Windows).
	 *
	 * @param args - Command and arguments as separate strings (avoids quoting issues).
	 * @returns The same TaskBuilder instance for method chaining.
	 *
	 * @example
	 * .exec('npm', 'run', 'build')
	 * .exec('echo', 'Hello World')
	 */
	exec: (...args: string[]) => TaskBuilder;

	/**
	 * Logs informational messages during task execution.
	 *
	 * @param args - Values to log. Converted to strings and joined with spaces.
	 * @returns The same TaskBuilder instance for method chaining.
	 */
	log: (...args: string[]) => TaskBuilder;

	/**
	 * Logs warning messages during task execution.
	 *
	 * @param args - Values to log. Converted to strings and joined with spaces.
	 * @returns The same TaskBuilder instance for method chaining.
	 */
	warn: (...args: string[]) => TaskBuilder;

	/**
	 * Logs error messages during task execution.
	 *
	 * @param args - Values to log. Converted to strings and joined with spaces.
	 * @returns The same TaskBuilder instance for method chaining.
	 */
	error: (...args: string[]) => TaskBuilder;
}

/**
 * Main interface for the Violet task runner.
 *
 * Provides methods to define named tasks and configure global logging behavior.
 * Use this to build a task graph and control runtime diagnostics.
 *
 * @example
 *
 * violet.logLevel('warn');
 *
 * violet.addTask('build')
 *   .exec('tsc')
 *   .log('Compilation complete');
 */
export interface Violet {
	/**
	 * Defines a new task with the given name.
	 *
	 * @param name - The unique name of the task. Overide ununique.
	 * @returns A {@link TaskBuilder} instance for fluent configuration of the task.
	 *
	 * @example
	 * violet.addTask('clean')
	 *   .exec('rm', '-rf', '~/');
	 */
	addTask: (name: string) => TaskBuilder;
}

class TaskBuilderImpl implements TaskBuilder {
	private _jobs: Array<() => void | Promise<void>> = [];
	private _deps: string[] = [];
	private _ctx: Ctx = {};

	constructor(
		private _violet: VioletImpl,
		private _name: string,
	) {}

	dep(...tasks: string[]): this {
		if (!Array.isArray(tasks) || !tasks.length) {
			this._warn("dep() expects an array of function");
			return this;
		}

		this._deps.push(...tasks);
		return this;
	}

	run(...fns: Array<(ctx: Ctx) => Promise<Ctx | void> | (Ctx | void)>): this {
		if (!Array.isArray(fns) || !fns.length) {
			this._warn("run() expects an array of function");
			return this;
		}

		for (const fn of fns) {
			this._jobs.push(async () => {
				const ret = await fn(this._ctx);
				if (ret !== undefined) this._ctx = ret;
			});
		}
		return this;
	}

	parallel(
		...fns: Array<(ctx: Ctx) => Promise<Ctx | void> | (Ctx | void)>
	): this {
		if (!Array.isArray(fns) || !fns.length) {
			this._warn("parallel() expects an array of function");
			return this;
		}

		this._jobs.push(async () => {
			await Promise.all(
				fns.map(async (fn) => {
					const ret = await fn(this._ctx);
					if (ret !== undefined) this._ctx = ret;
				}),
			);
		});
		return this;
	}

	exec(...args: string[]): this {
		if (!Array.isArray(args) || !args.length) {
			this._warn("exec() expects an array of function");
			return this;
		}
		const exe = (cmd: string): Promise<void> =>
			new Promise((res, rej) => {
				exec(cmd, (error, stdout, stderr) => {
					if (error) {
						this._error(error.message);
						rej();
					}
					if (stderr) {
						this._warn(stderr);
						rej();
					}
					if (stdout) {
						this._log(stdout);
						res();
					}
				});
			});

		this._jobs.push(async () => await exe(args.join(" ")));
		return this;
	}

	log(...args: string[]): this {
		this._jobs.push(() => console.log(`[${this._name}] LOG:`, ...args));
		return this;
	}

	warn(...args: string[]): this {
		this._jobs.push(() => console.warn(`[${this._name}] WARN:`, ...args));
		return this;
	}

	error(...args: string[]): TaskBuilder {
		this._jobs.push(() => console.warn(`[${this._name}] ERROR:`, ...args));
		return this;
	}

	_log(msg: string) {
		console.log(`[${this._name}] LOG:`, msg);
	}

	_warn(msg: string) {
		console.warn(`[${this._name}] WARN:`, msg);
	}

	_error(msg: string) {
		console.error(`[${this._name}] ERROR:`, msg);
	}

	async _complete(): Promise<void> {
		if (this._deps.length) {
			await Promise.all(this._deps.map((dep) => this._violet._runTask(dep)));
		}

		for (const job of this._jobs) {
			await job();
		}

		this._log("Task completed");
	}
}

class VioletImpl implements Violet {
	private _tasks: Map<string, TaskBuilderImpl> = new Map();

	addTask(name: string): TaskBuilderImpl {
		const task = new TaskBuilderImpl(this, name);
		this._tasks.set(name, task);
		return task;
	}

	async _runTask(name: string): Promise<void> {
		const task = this._tasks.get(name);

		if (!task) {
			return;
		}

		await task._complete();
	}
}

const violet = new VioletImpl();

async function findVioletFile() {
	const files = await readdir(process.cwd());
	const target = files.find((f) => /^violet\.ts$/i.test(f));

	if (!target) throw new Error("No violet.ts or Violet.ts file found");

	return resolve(join(process.cwd(), target));
}

(async () => {
	const task = process.argv[2];
	if (!task) return;

	const { default: run } = await import(await findVioletFile());
	await run?.(violet);
	await violet._runTask(task);
})();
