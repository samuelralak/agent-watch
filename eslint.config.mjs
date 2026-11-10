// Biome formats and lints this project. ESLint is here for the one thing Biome has no rule for:
// empty lines between blocks and logical blocks.
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

const DECLARATIONS = ['const', 'let'];

/** Statements that read as a block: every control structure, and anything that spans lines. */
const BLOCKS = [
  'if',
  'for',
  'while',
  'do',
  'switch',
  'try',
  'block-like',
  'multiline-const',
  'multiline-let',
  'multiline-expression',
  'multiline-export',
  'multiline-type',
];

export default [
  { ignores: ['dist/**', 'test/.build/**', 'node_modules/**'] },
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },

        // A group of declarations is set apart from what comes before and after it.
        { blankLine: 'always', prev: DECLARATIONS, next: '*' },
        { blankLine: 'always', prev: '*', next: DECLARATIONS },
        { blankLine: 'any', prev: DECLARATIONS, next: DECLARATIONS },

        // An empty line before and after every block.
        { blankLine: 'always', prev: '*', next: BLOCKS },
        { blankLine: 'always', prev: BLOCKS, next: '*' },

        // How a function ends stands apart from the work that led to it.
        { blankLine: 'always', prev: '*', next: ['return', 'throw'] },

        // A case with a body is a block too. Labels stacked on one body stay together.
        { blankLine: 'always', prev: { selector: 'SwitchCase[consequent.length>0]' }, next: '*' },
        { blankLine: 'never', prev: { selector: 'SwitchCase[consequent.length=0]' }, next: '*' },
      ],
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
    },
  },
  {
    // A function that does not fit on a screen is doing more than one thing.
    files: ['src/**/*.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Text, not logic: the shell scripts the hooks run, and the help the view shows.
    files: ['src/**/*.script.ts', 'src/tui/views/panels.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
];
