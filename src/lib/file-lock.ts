/**
 * 파일별 promise queue — async 흐름 중 critical section 직렬화.
 *
 * JS는 단일 스레드라서 sync 코드는 이미 atomic이지만, async 함수 안에서
 * `load → await → mutate → save` 패턴이 있으면 await 사이에 다른 async 흐름이
 * 끼어들어 같은 파일을 수정한 후 stale state로 save하는 race가 가능.
 *
 * 사용:
 *   await withFileLock(MEMORY_FILE, async () => {
 *     const m = loadAgentMemory(agent);
 *     // ... await/sync mix
 *     saveAgentMemory(m);
 *   });
 *
 * 같은 path에 대한 모든 callback은 순서대로 직렬 실행됨.
 * 다른 path는 병렬 가능.
 */

const fileLocks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = fileLocks.get(path) ?? Promise.resolve();

  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  // 이 path에 대한 다음 작업은 현재 작업이 끝난 후 시작
  fileLocks.set(path, prev.then(() => next));

  // 이전 작업 완료 대기
  await prev;

  try {
    return await fn();
  } finally {
    release!();
    // 큐 비어 있으면 정리 (메모리 누수 방지)
    if (fileLocks.get(path) === next) {
      fileLocks.delete(path);
    }
  }
}
