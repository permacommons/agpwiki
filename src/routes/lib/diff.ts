import { createTwoFilesPatch } from 'diff';

import { normalizeForDiff, renderUnifiedDiff } from '../../render.js';

type DiffOptions = {
  fromLabel: string;
  toLabel: string;
  fromText: string;
  toText: string;
};

export const renderRevisionDiff = ({ fromLabel, toLabel, fromText, toText }: DiffOptions) => {
  const diff = createTwoFilesPatch(
    `rev:${fromLabel}`,
    `rev:${toLabel}`,
    normalizeForDiff(fromText),
    normalizeForDiff(toText),
    '',
    '',
    { context: 2 }
  );
  const diffRendered = renderUnifiedDiff(diff);
  return `<details class="page-diff" open>
  <summary>Revision diff</summary>
  <pre class="diff">${diffRendered}</pre>
</details>`;
};
