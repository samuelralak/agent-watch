import { describe, expect, it } from 'vitest';
import { distinctLabels } from '../../src/tui/labels.js';

describe('agent labels shown side by side', () => {
  it('drop the words they all start with', () => {
    expect(
      distinctLabels([
        'Adversarial review: messaging security',
        'Adversarial review: hook scripts, installer',
        'Adversarial review: data path correctness',
      ]),
    ).toEqual(['messaging security', 'hook scripts, installer', 'data path correctness']);
  });

  it('keep what tells them apart when one label is the start of another', () => {
    expect(distinctLabels(['Run the tests', 'Run the tests again'])).toEqual([
      'tests',
      'tests again',
    ]);
  });

  it('are cut at a word boundary, never inside a word', () => {
    expect(distinctLabels(['Review 5f batch A patch', 'Review 5f batch B patch'])).toEqual([
      'A patch',
      'B patch',
    ]);

    expect(distinctLabels(['Builder alpha', 'Building beta'])).toEqual([
      'Builder alpha',
      'Building beta',
    ]);
  });

  it('stay whole when there is nothing worth removing, or one would be left empty', () => {
    expect(distinctLabels(['5e builder', 'Build 5f overnight prep'])).toEqual([
      '5e builder',
      'Build 5f overnight prep',
    ]);

    expect(distinctLabels(['Review: ', 'Review: the patch'])).toEqual([
      'Review: ',
      'Review: the patch',
    ]);

    expect(distinctLabels(['only one'])).toEqual(['only one']);
  });
});
