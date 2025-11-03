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
export type LogLevel = "log" | "warn";

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

	/**
	 * Sets the global log level.
	 *
	 * Controls which log messages are displayed during task execution:
	 * - `'log'`: Debug log
	 * - `'warn'`: Warnings and errors
	 *
	 * @param level - The minimum severity level to display.
	 *
	 * @example
	 * violet.logLevel('warn'); // Only show warnings and errors
	 */
	logLevel: (level: LogLevel) => void;
}

function exeCommand(cmd: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		exec(cmd, (error, stdout, stderr) => {
			if (error) {
				console.error(`Error: ${error.message}`);
				reject(error);
				return;
			}
			if (stderr) {
				console.error(`Stderr: ${stderr}`);
			}
			resolve();
		});
	});
}

class TaskBuilderImpl implements TaskBuilder {
	private _jobs: Array<() => void | Promise<void>> = [];
	private _deps: string[] = [];
	private _ctx: Ctx = new Object();

	constructor(
		private _violet: VioletImpl,
		private _name: string,
	) {}

	dep(...tasks: string[]): this {
		if (!Array.isArray(tasks) || !tasks.length) {
			this._violet._warn(
				`[${this._name}] ERROR: dep() expects an arra of function`,
			);
			return this;
		}

		for (const task of tasks) {
			this._deps.push(task);
		}
		return this;
	}

	run(...fns: Array<(ctx: Ctx) => Promise<Ctx | void> | (Ctx | void)>): this {
		if (!Array.isArray(fns) || !fns.length) {
			this._violet._warn(
				`[${this._name}] ERROR: run() expects an arra of function`,
			);
			return this;
		}

		for (const fn of fns) {
			this._jobs.push(async () => {
				const ctx = await fn(this._ctx);
				if (ctx) this._ctx = ctx;
			});
		}
		return this;
	}

	parallel(
		...fns: Array<(ctx: Ctx) => Promise<Ctx | void> | (Ctx | void)>
	): this {
		if (!Array.isArray(fns) || !fns.length) {
			this._violet._warn(
				`[${this._name}] ERROR: parallel() expects an arra of function`,
			);
			return this;
		}

		this._jobs.push(async () => {
			await Promise.all(
				fns.map(async (fn) => {
					const ctx = await fn(this._ctx);
					if (ctx) this._ctx = ctx;
				}),
			);
		});
		return this;
	}

	exec(...args: string[]): this {
		if (!Array.isArray(args) || !args.length) {
			this._violet._warn(
				`[${this._name}] ERROR: exec() expects an arra of function`,
			);
			return this;
		}

		this._jobs.push(async () => {
			await exeCommand(args.join(" "));
		});
		return this;
	}

	log(...args: string[]): this {
		this._jobs.push(() => console.log(`[${this._name}] LOG: `, ...args));
		return this;
	}

	warn(...args: string[]): this {
		this._jobs.push(() => console.warn(`[${this._name}] WARN: `, ...args));
		return this;
	}

	async _complete(): Promise<void> {
		if (this._deps.length) {
			await Promise.all(this._deps.map((dep) => this._violet._runTask(dep)));
		}

		for (const job of this._jobs) {
			await job();
		}

		this._violet._log(`[${this._name}] LOG: Task completed`);
	}
}

const LogLevelHierarchy: Record<LogLevel, number> = {
	warn: 2,
	log: 3,
};

class VioletImpl implements Violet {
	private _tasks: Map<string, TaskBuilderImpl> = new Map();
	private _log_level: number = 1;

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

	logLevel(level: LogLevel): void {
		this._log_level = LogLevelHierarchy[level];
	}

	_shouldLog(msgLevel: keyof typeof LogLevelHierarchy): boolean {
		return (
			LogLevelHierarchy[msgLevel] <= this._log_level && this._log_level > 0
		);
	}

	_log(str: string): void {
		if (this._shouldLog("log")) {
			console.log(str);
		}
	}

	_warn(str: string): void {
		if (this._shouldLog("warn")) {
			console.warn(str);
		}
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
