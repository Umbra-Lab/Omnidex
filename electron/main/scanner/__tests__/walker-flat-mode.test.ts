import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walkRootWithDiagnostics } from '../walker';

/**
 * Flat walk for content (course) locations.
 *
 * Pack detection is the wrong tool for a course library: it hunts for
 * `.uasset`, a `Content/` directory, or UE-interior folder names, and video
 * courses routinely ship a UE sample project inside them. The finder walked
 * straight past the course and registered the sample — plus every "Class
 * Project File" and "Course Materials" folder — as separate assets. On the
 * real library that turned 51 courses into 211 rows.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'omnidex-flat-'));

  // A course containing a UE sample project, the shape that caused the bug.
  const course = join(root, 'Udemy - Some Course');
  mkdirSync(join(course, '01 - Intro'), { recursive: true });
  mkdirSync(join(course, 'StackOBot', 'Content'), { recursive: true });
  writeFileSync(join(course, 'StackOBot', 'Content', 'Thing.uasset'), 'x');

  mkdirSync(join(root, 'Artstation - Another Course', '01 - Setup'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('walkRootWithDiagnostics flat mode', () => {
  it('records every top-level folder and descends no further', async () => {
    const { folders } = await walkRootWithDiagnostics(root, { flat: true });
    expect(folders.map((f) => f.name).sort()).toEqual([
      'Artstation - Another Course',
      'Udemy - Some Course',
    ]);
  });

  it('pack detection on the same tree finds the sample project instead', async () => {
    // Documents exactly what flat mode is avoiding — if this ever stops being
    // true the flat mode has become unnecessary, not the test wrong.
    const { folders } = await walkRootWithDiagnostics(root);
    expect(folders.some((f) => f.name === 'StackOBot')).toBe(true);
  });

  it('still reports a real size for each course', async () => {
    const { folders } = await walkRootWithDiagnostics(root, { flat: true });
    const course = folders.find((f) => f.name === 'Udemy - Some Course');
    expect(course).toBeDefined();
    expect(course?.fileSize).toBeGreaterThan(0);
  });
});
