import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  invalidated: [] as string[],
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  cite: { fileId: 1, seconds: 42 },
}));

const lesson = (id: number, position: number) => ({
  id,
  rel_path: `Course/L${id}.mp4`,
  abs_path: `/lib/Course/L${id}.mp4`,
  kind: 'video',
  chapter: null,
  duration_seconds: 100,
  position_seconds: position,
  completed: 0,
  has_subtitle: 0,
});
const FILES = [lesson(1, 0), lesson(2, 10)];

vi.mock('@/ipc/trpc', () => {
  const inv = (name: string) => ({ invalidate: async () => void api.invalidated.push(name) });
  return {
    trpc: {
      useUtils: () => ({
        courses: {
          ...inv('courses'),
          files: inv('courses.files'),
          list: inv('courses.list'),
          get: inv('courses.get'),
        },
      }),
      courses: {
        list: {
          useQuery: () => ({
            data: [
              {
                id: 9,
                name: 'Course',
                display_title: null,
                tutorial_source: null,
                percent_complete: 0,
                duration_seconds: 200,
                video_count: 2,
                chapter_count: 0,
                subtitle_count: 0,
                archive_count: 0,
                has_manifest: 1,
              },
            ],
          }),
        },
        searchTranscripts: { useQuery: () => ({ data: [] }) },
        files: { useQuery: () => ({ data: FILES }) },
        get: { useQuery: () => ({ data: { name: 'Course', duration_seconds: 200 } }) },
        subtitleTrack: { useQuery: () => ({ data: null }) },
        setProgress: {
          useMutation: () => ({ mutate: api.mutate, mutateAsync: api.mutateAsync }),
        },
      },
    },
  };
});
vi.mock('@/features/learn/AskPane', () => ({
  AskPane: ({ onSeek }: { onSeek: (id: number, s: number) => void }) => (
    <button
      type="button"
      data-testid="cite"
      onClick={() => onSeek(api.cite.fileId, api.cite.seconds)}
    >
      cite
    </button>
  ),
}));

import { LearnView } from '../LearnView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** jsdom has no media pipeline; give the element the state a loaded video has. */
function stubMedia(v: HTMLVideoElement, currentTime = 0) {
  let t = currentTime;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: () => t,
    set: (x: number) => {
      t = x;
    },
  });
  Object.defineProperty(v, 'duration', { configurable: true, get: () => 100 });
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 1 });
}

const video = () => container.querySelector('[data-testid="course-player"]') as HTMLVideoElement;
const lessons = () =>
  [...container.querySelectorAll('[data-testid="course-lesson"]')] as HTMLButtonElement[];
const cite = () => container.querySelector('[data-testid="cite"]') as HTMLButtonElement;

/** Every progress write, whichever mutation entry point made it. */
const saves = () => [...api.mutate.mock.calls, ...api.mutateAsync.mock.calls].map((c) => c[0]);

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

async function fire(el: HTMLElement, type: string) {
  await act(async () => {
    el.dispatchEvent(new Event(type));
  });
}

describe('Learn player', () => {
  beforeEach(async () => {
    api.invalidated = [];
    api.mutate.mockReset();
    api.mutateAsync.mockReset().mockResolvedValue(undefined);
    api.cite = { fileId: 1, seconds: 42 };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<LearnView />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('seeks the lesson already playing when a citation points into it', async () => {
    await click(lessons()[0] as HTMLButtonElement);
    stubMedia(video(), 5);
    await fire(video(), 'loadedmetadata');
    await click(cite());
    expect(video().currentTime).toBe(42);
  });

  it('does not carry a citation time into the next lesson opened by Resume', async () => {
    await click(cite()); // lesson 1 at 0:42
    stubMedia(video());
    await fire(video(), 'ended');
    expect(video()).toBeNull();

    const resume = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Resume'),
    ) as HTMLButtonElement;
    await click(resume); // lesson 2, saved at 0:10
    stubMedia(video());
    await fire(video(), 'loadedmetadata');
    expect(video().currentTime).toBe(10);
  });

  it('refreshes progress after a pause save, but not on every timeupdate tick', async () => {
    await click(lessons()[0] as HTMLButtonElement);
    stubMedia(video(), 30);
    await fire(video(), 'timeupdate');
    await flush();
    expect(api.invalidated).toEqual([]);

    await fire(video(), 'pause');
    await flush();
    expect(api.invalidated).toEqual(
      expect.arrayContaining(['courses.files', 'courses.list', 'courses.get']),
    );
    expect(saves()).toContainEqual({ fileId: 1, positionSeconds: 30, completed: false });
  });

  it('refreshes progress after the save made when the lesson is closed', async () => {
    await click(lessons()[0] as HTMLButtonElement);
    stubMedia(video(), 30);
    await click(lessons()[1] as HTMLButtonElement); // unmounts lesson 1's player
    await flush();
    expect(api.invalidated).toEqual(
      expect.arrayContaining(['courses.files', 'courses.list', 'courses.get']),
    );
    expect(saves()).toContainEqual({ fileId: 1, positionSeconds: 30, completed: false });
  });
});
