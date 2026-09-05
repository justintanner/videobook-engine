import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(import.meta.resolve("@huggingface/transformers"));
const manifest = JSON.parse(await readFile(join(dirname(entry), "..", "package.json"), "utf8"));
if (manifest.version !== "4.2.0") throw new Error("Review the model-discovery download-policy patch before changing Transformers.js 4.2.0");
const replacements = [
  ['async function get_tokenizer_files(modelId) {', 'async function get_tokenizer_files(modelId, options = {}) {'],
  ['get_file_metadata(modelId, "tokenizer_config.json", {})', 'get_file_metadata(modelId, "tokenizer_config.json", options)'],
  ['get_tokenizer_files(pretrained_model_name_or_path);', 'get_tokenizer_files(pretrained_model_name_or_path, options);'],
  ['async function get_processor_files(modelId) {', 'async function get_processor_files(modelId, options = {}) {'],
  ['get_file_metadata(modelId, IMAGE_PROCESSOR_NAME, {})', 'get_file_metadata(modelId, IMAGE_PROCESSOR_NAME, options)'],
  ['async function get_model_files(modelId, { config = null, dtype: overrideDtype = null, device: overrideDevice = null, model_file_name = null } = {}) {',
    'async function get_model_files(modelId, { config = null, dtype: overrideDtype = null, device: overrideDevice = null, model_file_name = null, cache_dir = null, local_files_only = false, revision = "main" } = {}) {'],
  ['config = await get_config(modelId, { config });\n  const files = [', 'config = await get_config(modelId, { config, cache_dir, local_files_only, revision });\n  const files = ['],
  ['  include_tokenizer = true,\n  include_processor = true\n} = {}) {',
    '  include_tokenizer = true,\n  include_processor = true,\n  cache_dir = null,\n  local_files_only = false,\n  revision = "main"\n} = {}) {'],
  ['get_model_files(modelId, { config, dtype, device, model_file_name });',
    'get_model_files(modelId, { config, dtype, device, model_file_name, cache_dir, local_files_only, revision });'],
  ['const tokenizerFiles = await get_tokenizer_files(modelId);',
    'const tokenizerFiles = await get_tokenizer_files(modelId, { cache_dir, local_files_only, revision });'],
  ['const processorFiles = await get_processor_files(modelId);',
    'const processorFiles = await get_processor_files(modelId, { cache_dir, local_files_only, revision });'],
  ['get_pipeline_files(task, model, {\n    device,\n    dtype\n  });',
    'get_pipeline_files(task, model, {\n    device,\n    dtype,\n    config,\n    cache_dir,\n    local_files_only,\n    revision\n  });'],
  ['get_file_metadata(model, file))', 'get_file_metadata(model, file, { cache_dir, local_files_only, revision }))'],
  ['get_model_files(pretrained_model_name_or_path, {\n          config,\n          dtype,\n          device,\n          model_file_name\n        });',
    'get_model_files(pretrained_model_name_or_path, {\n          config,\n          dtype,\n          device,\n          model_file_name,\n          cache_dir,\n          local_files_only,\n          revision\n        });'],
];
const original = await readFile(entry, "utf8");
let patched = original;
for (const [before, after] of replacements) {
  const beforeCount = patched.split(before).length - 1;
  const afterCount = patched.split(after).length - 1;
  if (beforeCount === 0 && afterCount === 1) continue;
  if (beforeCount !== 1 || afterCount !== 0) throw new Error(`Unexpected Transformers.js model-discovery source: ${before}`);
  patched = patched.replace(before, after);
}
if (patched !== original) await writeFile(entry, patched);
