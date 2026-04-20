declare module '@lydell/node-pty' {
  export interface IDisposable {
    dispose(): void;
  }

  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    readonly process: string;
    onData(cb: (data: string) => void): IDisposable;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): IDisposable;
    resize(columns: number, rows: number): void;
    write(data: string | Buffer): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string | undefined };
    encoding?: string | null;
    handleFlowControl?: boolean;
    flowControlPause?: string;
    flowControlResume?: string;
    uid?: number;
    gid?: number;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions,
  ): IPty;
}
