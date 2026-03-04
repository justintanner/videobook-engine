// LFS patterns — matches clipfirst-mcp/src/git_versioning.py
export const LFS_PATTERNS: string[] = [
  '*.mp4',
  '*.mov',
  '*.webm',
  '*.avi',
  '*.mkv',
  '*.m4v',
  '*.flv',
  '*.mp3',
  '*.wav',
  '*.m4a',
  '*.aac',
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.webp',
  '*.gif',
  '*.bmp',
  '*.tiff',
];

// Gitignore contents — matches Python exactly
export const PROJECT_GITIGNORE = `# Lock files (in-progress state)
*.lock
.generating.lock
.transcribing.lock

# System files
.DS_Store
Thumbs.db

# Logs directory
.logs/

`;
