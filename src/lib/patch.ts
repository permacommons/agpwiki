import { applyPatch } from 'diff';

export type PatchFormat = 'unified' | 'codex';

type PatchOptions = {
  expectedFile?: string;
};

const hunkHeaderRegex = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

const validateHunkHeaders = (lines: string[]) => {
  const invalidHunk = lines.find(line => line.startsWith('@@') && !hunkHeaderRegex.test(line));
  if (invalidHunk) {
    throw new Error(
      `Patch format not supported. Invalid @@ hunk header: "${invalidHunk}". ` +
        'Expected "@@ -<start>,<count> +<start>,<count> @@" with line numbers.'
    );
  }
};

const normalizeCodexPatch = (patch: string, expectedFile?: string) => {
  const lines = patch.split('\n');
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Patch format not supported. Expected "*** Begin Patch" header.');
  }

  let updateTarget: string | null = null;
  const diffLines: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('*** Update File: ')) {
      if (updateTarget) {
        throw new Error('Patch format not supported. Multiple update targets found.');
      }
      updateTarget = line.slice('*** Update File: '.length).trim();
      continue;
    }
    if (line.startsWith('*** Add File:') || line.startsWith('*** Delete File:')) {
      throw new Error('Patch format not supported. Add/Delete file operations are not supported.');
    }
    if (line === '*** End Patch' || line === '*** End of File') {
      continue;
    }
    if (
      line.startsWith('@@') ||
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ')
    ) {
      diffLines.push(line);
    }
  }

  if (!updateTarget) {
    throw new Error('Patch format not supported. Missing "*** Update File:" line.');
  }
  const normalizedTarget = updateTarget.replace(/^\/+/, '');
  if (expectedFile && normalizedTarget !== expectedFile) {
    throw new Error(`Patch target mismatch. Expected "${expectedFile}", got "${updateTarget}".`);
  }
  if (!diffLines.some(line => line.startsWith('@@'))) {
    throw new Error('Patch format not supported. Missing @@ hunk header.');
  }
  validateHunkHeaders(diffLines);

  const headerTarget = expectedFile ?? normalizedTarget;
  const header = `--- a/${headerTarget}\n+++ b/${headerTarget}`;
  return `${header}\n${diffLines.join('\n')}`;
};

export const normalizePatch = (patch: string, format: PatchFormat, options?: PatchOptions) => {
  if (format === 'codex') {
    return normalizeCodexPatch(patch, options?.expectedFile);
  }
  if (!patch.includes('@@')) {
    throw new Error('Patch format not supported. Missing @@ hunk header.');
  }
  if (patch.includes('*** Begin Patch')) {
    throw new Error('Patch format not supported. Expected unified diff format.');
  }
  validateHunkHeaders(patch.split('\n'));
  return patch;
};

export const applyUnifiedPatch = (
  currentText: string,
  patch: string,
  format: PatchFormat,
  options?: PatchOptions
) => {
  const normalized = normalizePatch(patch, format, options);
  const patched = applyPatch(currentText, normalized, { fuzzFactor: 0 });
  if (patched === false) {
    throw new Error('Patch could not be applied to the current content.');
  }
  if (patched === currentText) {
    throw new Error('Patch did not change the content.');
  }
  return patched;
};
