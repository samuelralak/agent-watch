/** A shared prefix shorter than this is not worth removing. */
const MIN_PREFIX = 6;

/**
 * Labels with the words they all begin with removed, so agents named "Adversarial review:
 * security" and "Adversarial review: data path" read as "security" and "data path". The prefix
 * is cut at a word boundary, and nothing changes if any label would be left empty.
 */
export function distinctLabels(labels: readonly string[]): string[] {
  const first = labels[0];

  if (labels.length < 2 || first === undefined) {
    return [...labels];
  }

  let shared = first.length;

  for (const label of labels) {
    let i = 0;

    while (i < shared && i < label.length && label[i] === first[i]) {
      i++;
    }

    shared = i;
  }

  let cut = 0;

  for (let i = 0; i < shared; i++) {
    if (first[i] === ' ' || first[i] === ':' || first[i] === '/') {
      cut = i + 1;
    }
  }

  while (first[cut] === ' ') {
    cut++;
  }

  if (cut < MIN_PREFIX || labels.some((label) => label.length <= cut)) {
    return [...labels];
  }

  return labels.map((label) => label.slice(cut));
}
