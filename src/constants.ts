// Port of clipfirst-mcp/src/constants.py — all filename and path constants

// Lock files (gitignored, for in-progress state)
export const LOCK_TRANSCRIBING = '.transcribing.lock';
export const LOCK_GENERATING = '.generating.lock';
export const LOCK_RENDERING_LANDSCAPE = '.rendering-landscape.lock';
export const LOCK_RENDERING_PORTRAIT = '.rendering-portrait.lock';
export const LOCK_RENDERING_SQUARE = '.rendering-square.lock';
export const LOCK_DOWNLOADING = '.downloading.lock';
export const LOCK_ISOLATING = '.isolating.lock';
export const LOCK_TRIMMING = '.trimming.lock';
export const LOCK_SPEED_CHANGE = '.speed-change.lock';
export const LOCK_REVERSING = '.reversing.lock';
export const LOCK_TIMELINE = '.timeline.lock';
export const LOCK_ANALYZING = '.analyzing.lock';

// Error files (git-tracked, for persistent error state)
export const ERROR_TRANSCRIBE = '.transcribe.error';
export const ERROR_GENERATING = '.generating.error';
export const ERROR_RENDER = '.render.error';
export const ERROR_LANDSCAPE = '.landscape.error';
export const ERROR_PORTRAIT = '.portrait.error';
export const ERROR_SQUARE = '.square.error';
export const ERROR_TIMELINE = '.timeline.error';
export const ERROR_ANALYZE = '.analyze.error';

// Render settings (git-tracked)
export const SETTINGS_LANDSCAPE = '.landscape.json';
export const SETTINGS_PORTRAIT = '.portrait.json';
export const SETTINGS_SQUARE = '.square.json';

// Timeouts
export const RENDER_TIMEOUT_SECONDS = 600;

// Generation metadata files
export const TOOL_PARAMS_FILE = '.tool.params.json';
export const KIE_PAYLOAD_FILE = '.kie.payload.json';
export const FRAME_ANALYSIS_JSONL = '.frame_analysis.jsonl';
export const QUICK_ANALYSIS_FILE = '.quick-analysis.json';

// Project metadata
export const PROJECT_METADATA = '.project';
export const PROMPT_LOG = '.prompt_log.jsonl';
export const DEFAULT_PROJECT_FILE = '.default-project';

// Asset timestamps
export const CREATED_AT_FILE = '.created_at';
export const WHITELISTED_AT_FILE = '.whitelisted_at';

// Original metadata
export const ORIGINAL_METADATA_FILE = '.original.json';

// Content files
export const ORIGINAL_VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', 'flv'];
export const THUMBNAIL = 'thumbnail.jpg';
export const EL_JSON = 'elevenlabs.json';
export const SRT_ORIGINAL_EL = 'original.el.srt';
export const SRT_ORIGINAL_EN = 'original.en.srt';

// Audio
export const AUDIO_ORIGINAL = 'audio_original.mp3';
export const AUDIO_VOCALS = 'audio_vocals.mp3';
export const AUDIO_BACKGROUND = 'audio_background.mp3';
export const AUDIO_NORMALIZED = 'audio_normalized.mp3';
export const MUSIC_MP3 = 'music.mp3';
export const AUDIO_TRACKS_JSON = '.audio-tracks.json';
export const MIX_JSON = '.mix.json';
export const MIX_MP3 = 'mix.mp3';

// Video exports
export const EXPORT_LANDSCAPE_CLEAN = '1920x1080_landscape.mp4';
export const EXPORT_PORTRAIT_CLEAN = '1080x1920_portrait.mp4';
export const EXPORT_SQUARE_CLEAN = '1080x1080_square.mp4';

// Overlays
export const OSG_LANDSCAPE = '1920x1080_osg.png';
export const OSG_PORTRAIT = '1080x1920_osg.png';
export const OSG_SQUARE = '1080x1080_osg.png';

// Image resizes
export const IMAGE_LANDSCAPE = 'image_1920x1080.jpg';
export const IMAGE_PORTRAIT = 'image_1080x1920.jpg';
export const IMAGE_SQUARE = 'image_1080x1080.jpg';

// Text files
export const INDEX_MD = 'index.md';
export const DIALOG_MP3 = 'dialog.mp3';

// Frame extraction
export const ORIGINAL_FRAMES_DIR = 'original_frames';
export const LANDSCAPE_FRAMES_DIR = 'landscape_frames';
export const PORTRAIT_FRAMES_DIR = 'portrait_frames';
export const SQUARE_FRAMES_DIR = 'square_frames';

// Directory prefixes
export const DIR_PREFIX_VIDEO = 'vid-';
export const DIR_PREFIX_AUDIO = 'aud-';
export const DIR_FINAL = 'final';

// Plan document
export const PLAN_MD = '.plan.md';
export const PLAN_HISTORY = '.plan.history.jsonl';

// Timeline output
export const TIMELINE_LANDSCAPE = 'timeline_1920x1080.mp4';
export const TIMELINE_PORTRAIT = 'timeline_1080x1920.mp4';
export const TIMELINE_LANDSCAPE_SRT = 'timeline_1920x1080.srt';
export const TIMELINE_PORTRAIT_SRT = 'timeline_1080x1920.srt';
export const TIMELINE_SQUARE = 'timeline_1080x1080.mp4';
export const TIMELINE_SQUARE_SRT = 'timeline_1080x1080.srt';

// Orientation maps
export const ORIENTATION_EXPORT_MAP: Record<string, string> = {
  landscape: EXPORT_LANDSCAPE_CLEAN,
  portrait: EXPORT_PORTRAIT_CLEAN,
  square: EXPORT_SQUARE_CLEAN,
};

export const SETTINGS_MAP: Record<string, string> = {
  landscape: SETTINGS_LANDSCAPE,
  portrait: SETTINGS_PORTRAIT,
  square: SETTINGS_SQUARE,
};

export const ERROR_MAP: Record<string, string> = {
  landscape: ERROR_LANDSCAPE,
  portrait: ERROR_PORTRAIT,
  square: ERROR_SQUARE,
};

export const LOCK_MAP: Record<string, string> = {
  landscape: LOCK_RENDERING_LANDSCAPE,
  portrait: LOCK_RENDERING_PORTRAIT,
  square: LOCK_RENDERING_SQUARE,
};

// Aspect ratio to orientation mapping
export const ASPECT_TO_ORIENTATION: Record<string, string> = {
  '16:9': 'landscape',
  '9:16': 'portrait',
  '1:1': 'square',
};

// File extensions for type detection (without dots)
export const VIDEO_FILENAME_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv'];
export const IMAGE_FILENAME_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'];
export const AUDIO_FILENAME_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
