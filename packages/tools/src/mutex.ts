export class AsyncMutex {
  #promise: Promise<void> | null = null;
  async acquire(): Promise<() => void> {
    while (this.#promise) {
      await this.#promise;
    }
    let release!: () => void;
    this.#promise = new Promise<void>((resolve) => {
      release = () => {
        this.#promise = null;
        resolve();
      };
    });
    return release;
  }
}
export const workspaceLock = new AsyncMutex();
export const checkpointLock = new AsyncMutex();
