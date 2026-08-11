import { createInterface } from "node:readline/promises";

export interface CliIO {
  readonly interactive: boolean;
  write(text: string): void;
  writeError(text: string): void;
  readLine(prompt: string, signal: AbortSignal): Promise<string | null>;
}

export class NodeCliIO implements CliIO {
  readonly interactive: boolean;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  readonly #error: NodeJS.WritableStream;

  constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    error: NodeJS.WritableStream,
    interactive: boolean,
  ) {
    this.#input = input;
    this.#output = output;
    this.#error = error;
    this.interactive = interactive;
  }

  write(text: string): void {
    this.#output.write(text);
  }

  writeError(text: string): void {
    this.#error.write(text);
  }

  async readLine(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (signal.aborted) return null;
    const inputState = this.#input as NodeJS.ReadableStream & {
      readonly destroyed?: boolean;
      readonly readableEnded?: boolean;
    };
    if (inputState.destroyed === true || inputState.readableEnded === true) {
      return null;
    }
    const reader = createInterface({
      input: this.#input,
      output: this.#output,
      terminal: this.interactive,
    });
    return await new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        reader.removeListener("close", onClose);
      };
      const succeed = (value: string | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reader.close();
        resolve(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reader.close();
        reject(error);
      };
      const onAbort = (): void => succeed(null);
      const onClose = (): void => succeed(null);

      signal.addEventListener("abort", onAbort, { once: true });
      reader.once("close", onClose);
      void reader.question(prompt).then(
        (answer) => succeed(answer),
        (error: unknown) => {
          if (
            signal.aborted
            || (error instanceof Error && error.name === "AbortError")
          ) {
            succeed(null);
            return;
          }
          fail(error);
        },
      );
    });
  }
}
