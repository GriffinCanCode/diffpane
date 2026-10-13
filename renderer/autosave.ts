/** Serialize writes and coalesce typing while a write is in flight. */
export class Autosave {
  private saved: string;
  private latest: string;
  private running: Promise<void> | null = null;
  private failure: unknown = null;

  constructor(
    initial: string,
    private write: (text: string, expected: string) => Promise<unknown>,
    private changed: (state: 'saving' | 'saved' | 'error', error?: unknown) => void,
  ) {
    this.saved = this.latest = initial;
  }

  get pending() {
    return this.running !== null || this.latest !== this.saved;
  }

  accept(text: string) {
    if (!this.pending) this.saved = this.latest = text;
  }

  edit(text: string) {
    this.latest = text;
    // A failed save retains the buffer until an explicit retry.
    if (!this.failure) void this.flush().catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.latest === this.saved) return;
    this.failure = null;
    this.changed('saving');
    this.running = Promise.resolve().then(async () => {
      try {
        while (this.latest !== this.saved) {
          const text = this.latest;
          await this.write(text, this.saved);
          this.saved = text;
        }
      } catch (error) {
        this.failure = error;
        this.changed('error', error);
        throw error;
      } finally {
        this.running = null;
        if (!this.failure) this.changed('saved');
      }
    });
    return this.running;
  }
}
