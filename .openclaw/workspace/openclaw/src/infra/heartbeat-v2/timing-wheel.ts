export interface TimerCallback {
  (): void | Promise<void>;
}

export interface TimerEntry {
  id: string;
  callback: TimerCallback;
  deadline: number;
}

interface WheelSlot {
  timers: Map<string, TimerEntry>;
}

interface WheelLevel {
  slots: WheelSlot[];
  currentIndex: number;
  slotDuration: number;
  numSlots: number;
}

export class HierarchicalTimingWheel {
  private levels: WheelLevel[];
  private lastTickMs: number;
  private readonly tickIntervalMs: number;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(tickIntervalMs: number = 50) {
    this.tickIntervalMs = tickIntervalMs;
    this.lastTickMs = Date.now();

    this.levels = [
      this.createLevel(20, 50),
      this.createLevel(60, 1000),
      this.createLevel(60, 60000),
      this.createLevel(24, 3600000),
    ];
  }

  private createLevel(numSlots: number, slotDuration: number): WheelLevel {
    const slots: WheelSlot[] = [];
    for (let i = 0; i < numSlots; i++) {
      slots.push({ timers: new Map() });
    }
    return {
      slots,
      currentIndex: 0,
      slotDuration,
      numSlots,
    };
  }

  addTimer(id: string, delayMs: number, callback: TimerCallback): void {
    if (delayMs < 0) {
      delayMs = 0;
    }

    const deadline = Date.now() + delayMs;
    const entry: TimerEntry = {
      id,
      callback,
      deadline,
    };

    this.cancelTimer(id);
    this.insertIntoWheel(entry, delayMs);
  }

  private insertIntoWheel(entry: TimerEntry, delayMs: number): void {
    let remainingMs = delayMs;

    for (let i = 0; i < this.levels.length; i++) {
      const lv = this.levels[i];
      const wheelDuration = lv.slotDuration * lv.numSlots;

      if (remainingMs < wheelDuration) {
        const slotOffset = Math.floor(remainingMs / lv.slotDuration);
        const slotIndex = (lv.currentIndex + slotOffset) % lv.numSlots;
        lv.slots[slotIndex].timers.set(entry.id, entry);
        return;
      }

      remainingMs = remainingMs % wheelDuration;
    }

    const lastLevel = this.levels[this.levels.length - 1];
    const lastSlot = (lastLevel.currentIndex + lastLevel.numSlots - 1) % lastLevel.numSlots;
    lastLevel.slots[lastSlot].timers.set(entry.id, entry);
  }

  cancelTimer(id: string): boolean {
    for (const level of this.levels) {
      for (const slot of level.slots) {
        if (slot.timers.delete(id)) {
          return true;
        }
      }
    }
    return false;
  }

  getTimerCount(): number {
    let count = 0;
    for (const level of this.levels) {
      for (const slot of level.slots) {
        count += slot.timers.size;
      }
    }
    return count;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTickMs = Date.now();

    this.tickInterval = setInterval(() => {
      this.tick();
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.isRunning = false;
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickMs;

    if (elapsed < this.tickIntervalMs) {
      return;
    }

    this.lastTickMs = now;
    this.processLevel(0, now);
  }

  private processLevel(levelIndex: number, now: number): void {
    const level = this.levels[levelIndex];
    const slot = level.slots[level.currentIndex];
    const timersToFire: TimerEntry[] = [];

    for (const entry of slot.timers.values()) {
      if (entry.deadline <= now) {
        timersToFire.push(entry);
      } else {
        this.insertIntoWheel(entry, entry.deadline - now);
      }
    }

    slot.timers.clear();

    for (const entry of timersToFire) {
      this.executeTimer(entry);
    }

    level.currentIndex = (level.currentIndex + 1) % level.numSlots;

    if (level.currentIndex === 0 && levelIndex < this.levels.length - 1) {
      this.cascadeFromLevel(levelIndex + 1, now);
    }
  }

  private executeTimer(entry: TimerEntry): void {
    try {
      const result = entry.callback();
      if (result instanceof Promise) {
        result.catch((err) => {
          console.error(`Timer callback error for ${entry.id}:`, err);
        });
      }
    } catch (err) {
      console.error(`Timer callback error for ${entry.id}:`, err);
    }
  }

  private cascadeFromLevel(levelIndex: number, now: number): void {
    const level = this.levels[levelIndex];
    const slot = level.slots[level.currentIndex];

    for (const entry of slot.timers.values()) {
      if (entry.deadline <= now) {
        this.executeTimer(entry);
      } else {
        this.insertIntoWheel(entry, entry.deadline - now);
      }
    }

    slot.timers.clear();
  }

  clear(): void {
    for (const level of this.levels) {
      for (const slot of level.slots) {
        slot.timers.clear();
      }
    }
  }
}