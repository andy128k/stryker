import * as os from 'os';
import { fork, ChildProcess } from 'child_process';
import { File } from 'stryker-api/core';
import { getLogger } from 'stryker-api/logging';
import { WorkerMessage, WorkerMessageKind, ParentMessage, autoStart, ParentMessageKind } from './messageProtocol';
import { serialize, deserialize, kill } from '../utils/objectUtils';
import Task from '../utils/Task';
import LoggingClientContext from '../logging/LoggingClientContext';
import StrykerError from '../utils/StrykerError';

type MethodPromised = { (...args: any[]): Promise<any> };

export type Promisified<T> = {
  [K in keyof T]: T[K] extends MethodPromised ? T[K] : T[K] extends Function ? MethodPromised : () => Promise<T[K]>;
};

export default class ChildProcessProxy<T> {
  readonly proxy: Promisified<T>;

  private worker: ChildProcess;
  private initTask: Task;
  private disposeTask: Task<void> | undefined;
  private currentError: StrykerError | undefined;
  private workerTasks: Task<any>[] = [];
  private log = getLogger(ChildProcessProxy.name);
  private lastMessagesQueue: string[] = [];
  private isDisposed = false;

  private constructor(requirePath: string, loggingContext: LoggingClientContext, plugins: string[], workingDirectory: string, constructorParams: any[]) {
    this.worker = fork(require.resolve('./ChildProcessProxyWorker'), [autoStart], { silent: true, execArgv: [] });
    this.initTask = new Task();
    this.send({
      kind: WorkerMessageKind.Init,
      loggingContext,
      plugins,
      requirePath,
      constructorArgs: constructorParams,
      workingDirectory
    });
    this.listenForMessages();
    this.listenToStdoutAndStderr();
    // This is important! Be sure to bind to `this`
    this.handleUnexpectedExit = this.handleUnexpectedExit.bind(this);
    this.worker.on('exit', this.handleUnexpectedExit);
    this.proxy = this.initProxy();
  }

  /**
  * Creates a proxy where each function of the object created using the constructorFunction arg is ran inside of a child process
  */
  static create<T, P1>(requirePath: string, loggingContext: LoggingClientContext, plugins: string[], workingDirectory: string, constructorFunction: { new(arg: P1): T }, arg: P1): ChildProcessProxy<T>;
  /**
  * Creates a proxy where each function of the object created using the constructorFunction arg is ran inside of a child process
  */
  static create<T, P1, P2>(requirePath: string, loggingContext: LoggingClientContext, plugins: string[], workingDirectory: string, constructorFunction: { new(arg: P1, arg2: P2): T }, arg1: P1, arg2: P2): ChildProcessProxy<T>;
  /**
  * Creates a proxy where each function of the object created using the constructorFunction arg is ran inside of a child process
  */
  static create<T>(requirePath: string, loggingContext: LoggingClientContext, plugins: string[], workingDirectory: string, _: { new(...params: any[]): T }, ...constructorArgs: any[]) {
    return new ChildProcessProxy(requirePath, loggingContext, plugins, workingDirectory, constructorArgs);
  }

  private send(message: WorkerMessage) {
    this.worker.send(serialize(message));
  }

  private initProxy(): Promisified<T> {
    // This proxy is a genuine javascript `Proxy` class
    // More info: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
    const self = this;
    return new Proxy({} as Promisified<T>, {
      get(_, propertyKey) {
        if (typeof propertyKey === 'string') {
          return self.forward(propertyKey);
        } else {
          return undefined;
        }
      }
    })
  }

  private forward(methodName: string) {
    return (...args: any[]) => {
      if (this.currentError) {
        return Promise.reject(this.currentError);
      } else {
        const workerTask = new Task<any>();
        const correlationId = this.workerTasks.push(workerTask) - 1;
        this.initTask.promise.then(() => {
          this.send({
            kind: WorkerMessageKind.Call,
            correlationId,
            methodName,
            args
          });
        });
        return workerTask.promise;
      }
    };
  }

  private listenForMessages() {
    this.worker.on('message', (serializedMessage: string) => {
      const message: ParentMessage = deserialize(serializedMessage, [File]);
      switch (message.kind) {
        case ParentMessageKind.Initialized:
          this.initTask.resolve(undefined);
          break;
        case ParentMessageKind.Result:
          this.workerTasks[message.correlationId].resolve(message.result);
          delete this.workerTasks[message.correlationId];
          break;
        case ParentMessageKind.Rejection:
          this.workerTasks[message.correlationId].reject(new Error(message.error));
          delete this.workerTasks[message.correlationId];
          break;
        case ParentMessageKind.DisposeCompleted:
          if (this.disposeTask) {
            this.disposeTask.resolve(undefined);
          }
          break;
        default:
          this.logUnidentifiedMessage(message);
          break;
      }
    });
  }

  private listenToStdoutAndStderr() {
    const traceEnabled = this.log.isTraceEnabled();
    const handleData = (data: Buffer) => {
      const msg = data.toString();
      this.lastMessagesQueue.push(msg);
      if (this.lastMessagesQueue.length > 10) {
        this.lastMessagesQueue.shift();
      }

      if (traceEnabled) {
        this.log.trace(msg);
      }
    };

    if (this.worker.stdout) {
      this.worker.stdout.on('data', handleData);
    }

    if (this.worker.stderr) {
      this.worker.stderr.on('data', handleData);
    }
  }

  private handleUnexpectedExit(code: number | null, signal: string) {
    this.log.debug(`Child process exited unexpectedly with exit code ${code} (${signal || 'without signal'}). ${stdoutAndStderr(this.lastMessagesQueue)}`);
    this.currentError = new StrykerError(`Child process exited unexpectedly (code ${code})`);
    this.workerTasks
      .filter(task => !task.isResolved)
      .forEach(task => task.reject(this.currentError));
    this.isDisposed = true;

    function stdoutAndStderr(messages: string[]) {
      if (messages.length) {
        return `Last part of stdout and stderr was: ${os.EOL}${
          messages.map(msg => `\t${msg}`).join(os.EOL)}`;
      } else {
        return 'Stdout and stderr were empty.';
      }
    }
  }

  public dispose(): Promise<void> {
    this.worker.removeListener('exit', this.handleUnexpectedExit);
    if (this.isDisposed) {
      return Promise.resolve();
    } else {
      this.disposeTask = new Task();
      this.send({ kind: WorkerMessageKind.Dispose });
      const killWorker = () => {
        kill(this.worker.pid);
        this.isDisposed = true;
      };
      return this.disposeTask.promise
        .then(killWorker)
        .catch(killWorker);
    }
  }

  private logUnidentifiedMessage(message: never) {
    this.log.error(`Received unidentified message ${message}`);
  }
}