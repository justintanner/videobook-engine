export async function withCleanWorktree<T>(
  projectDir: string,
  fn: () => Promise<T>,
  gitPath?: string,
): Promise<T> {
  void projectDir;
  void gitPath;
  return fn();
}
