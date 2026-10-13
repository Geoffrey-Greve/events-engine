import { describe, expect, it } from 'vitest';
import { collapseIntervals } from '../src/attendance';
import type { AttendanceInterval } from '../src/providers/types';

// collapseIntervals is the provider-agnostic core of the attendance pipeline:
// many join/leave spans → earliest join, latest leave, summed duration. Pure,
// so it's tested directly without the Workers runtime.

describe('collapseIntervals', () => {
  it('takes earliest join and latest leave across spans', () => {
    const intervals: AttendanceInterval[] = [
      { join: '2025-08-15T09:05:00Z', leave: '2025-08-15T09:30:00Z' },
      { join: '2025-08-15T09:00:00Z', leave: '2025-08-15T09:20:00Z' },
      { join: '2025-08-15T10:00:00Z', leave: '2025-08-15T10:15:00Z' },
    ];
    const c = collapseIntervals(intervals);
    expect(c.join).toBe('2025-08-15T09:00:00Z');
    expect(c.leave).toBe('2025-08-15T10:15:00Z');
    // 25 + 20 + 15 minutes of actual presence = 3600s
    expect(c.durationSeconds).toBe(60 * 60);
  });

  it('handles a single span', () => {
    const c = collapseIntervals([{ join: '2025-08-15T09:00:00Z', leave: '2025-08-15T09:45:00Z' }]);
    expect(c.join).toBe('2025-08-15T09:00:00Z');
    expect(c.leave).toBe('2025-08-15T09:45:00Z');
    expect(c.durationSeconds).toBe(45 * 60);
  });

  it('is null/zero for no intervals', () => {
    const c = collapseIntervals([]);
    expect(c.join).toBeNull();
    expect(c.leave).toBeNull();
    expect(c.durationSeconds).toBe(0);
  });

  it('ignores missing/zero-length spans without throwing', () => {
    const c = collapseIntervals([
      { join: '2025-08-15T09:00:00Z', leave: null },
      { join: null, leave: '2025-08-15T09:30:00Z' },
      { join: '2025-08-15T09:10:00Z', leave: '2025-08-15T09:10:00Z' },
    ]);
    expect(c.join).toBe('2025-08-15T09:00:00Z');
    expect(c.leave).toBe('2025-08-15T09:30:00Z');
    expect(c.durationSeconds).toBe(0);
  });
});
