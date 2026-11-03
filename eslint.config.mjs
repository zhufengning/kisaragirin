import {defineConfig, globalIgnores} from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default defineConfig([
    globalIgnores([
        'dist/**',
        'web/dist/**',
        'node_modules/**',
        'data/**',
        'graphiti/**'
    ]),
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.astro'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        plugins: {
            '@stylistic': stylistic
        },
        rules: {
            // Best practices
            'array-callback-return': [2],
            'block-scoped-var': [2],
            'curly': [2, 'multi-line'],
            'dot-notation': [2],
            'eqeqeq': [2],
            'no-alert': [2],
            'no-div-regex': [2],
            'no-else-return': [2],
            'no-eq-null': [2],
            'no-eval': [2],
            'no-extend-native': [2],
            'no-extra-bind': [2],
            'no-global-assign': [2],
            'no-implied-eval': [2],
            'no-invalid-this': [2],
            'no-iterator': [2],
            'no-lone-blocks': [2],
            'no-loop-func': [2],
            'no-multi-str': [2],
            'no-new': [2],
            'no-proto': [2],
            'no-return-assign': [2],
            'no-script-url': [2],
            'no-self-compare': [2],
            'no-sequences': [2],
            'no-throw-literal': [2],
            'no-unmodified-loop-condition': [2],
            'no-unused-expressions': [2],
            'no-useless-call': [2],
            'no-useless-concat': [2],
            'no-useless-escape': [2],
            'no-warning-comments': [0],
            'no-with': [2],
            'radix': [2],
            'wrap-iife': [2],
            'yoda': [2],

            // Variables
            'no-catch-shadow': [2],
            'no-shadow': [2],
            'no-undefined': [0],

            // Strict
            'strict': [2, 'never'],

            // Style
            'camelcase': [2, {
                properties: 'never'
            }],
            'no-lonely-if': [2],
            'no-unneeded-ternary': [2],
            'arrow-body-style': [2, 'as-needed'],
            'one-var': [2, 'never'],
            'no-prototype-builtins': [2],
            'no-confusing-arrow': [2],
            'no-duplicate-imports': [2],
            'no-return-await': [2],
            'no-template-curly-in-string': [2],
            'no-useless-computed-key': [2],
            'no-useless-constructor': [2],
            'no-useless-rename': [2],
            'no-var': [2],
            'prefer-arrow-callback': [2],
            'prefer-const': [2, { destructuring: 'all' }],
            'prefer-promise-reject-errors': [2],
            'prefer-rest-params': [2],
            'prefer-spread': [2],
            'prefer-template': [2],
            'require-atomic-updates': [2],
            'symbol-description': [2],

            '@stylistic/array-bracket-spacing': [2, 'never'],
            '@stylistic/block-spacing': [2, 'always'],
            '@stylistic/brace-style': [2],
            '@stylistic/comma-dangle': [2, 'never'],
            '@stylistic/comma-spacing': [2],
            '@stylistic/comma-style': [2],
            '@stylistic/dot-location': [2, 'property'],
            '@stylistic/eol-last': [2, 'always'],
            '@stylistic/function-call-spacing': [2, 'never'],
            '@stylistic/indent': [2, 4],
            '@stylistic/jsx-quotes': [2, 'prefer-double'],
            '@stylistic/key-spacing': [2, {
                beforeColon: false,
                afterColon: true,
                mode: 'strict'
            }],
            '@stylistic/keyword-spacing': [2, {
                before: true,
                after: true
            }],
            '@stylistic/linebreak-style': [2, 'unix'],
            '@stylistic/max-len': [2, {
                code: 120,
                tabWidth: 4,
                ignoreUrls: true,
                ignoreStrings: true,
                ignoreTemplateLiterals: true
            }],
            '@stylistic/new-parens': [2],
            '@stylistic/newline-per-chained-call': [2],
            '@stylistic/no-mixed-operators': [2],
            '@stylistic/no-multi-spaces': [2],
            '@stylistic/no-multiple-empty-lines': [2, {
                max: 2,
                maxBOF: 0,
                maxEOF: 0
            }],
            '@stylistic/no-tabs': [2],
            '@stylistic/no-trailing-spaces': [2, { skipBlankLines: true }],
            '@stylistic/object-curly-spacing': [2],
            '@stylistic/object-property-newline': [2, {
                allowAllPropertiesOnSameLine: true
            }],
            '@stylistic/operator-linebreak': [2, 'after'],
            '@stylistic/quote-props': [2, 'consistent-as-needed'],
            '@stylistic/quotes': [2, 'single', {
                allowTemplateLiterals: 'always',
                avoidEscape: true
            }],
            '@stylistic/semi': [2, 'always'],
            '@stylistic/semi-spacing': [2],
            '@stylistic/space-before-function-paren': [2, 'always'],
            '@stylistic/space-in-parens': [2],
            '@stylistic/space-infix-ops': [2],
            '@stylistic/space-unary-ops': [2],
            '@stylistic/spaced-comment': [2],
            '@stylistic/arrow-parens': [2, 'as-needed'],
            '@stylistic/arrow-spacing': [2, {
                before: true,
                after: true
            }],
            '@stylistic/rest-spread-spacing': [2, 'never'],
            '@stylistic/template-curly-spacing': [2, 'never'],

            '@typescript-eslint/no-explicit-any': [0],
            '@typescript-eslint/no-empty-object-type': [0],
            '@typescript-eslint/no-unused-vars': [2, { argsIgnorePattern: '^_' }]
        }
    },
    ...astro.configs.base,
    {
        files: ['**/*.astro'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                Astro: 'readonly'
            }
        },
        rules: {
            'no-alert': 0,
            'astro/no-conflict-set-directives': 2,
            'astro/no-unused-define-vars-in-style': 2
        }
    },
    {
        files: ['web/src/**/*.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser
            }
        },
        rules: {
            'no-alert': 0
        }
    },
    {
        files: ['**/*.astro/*.js', '**/*.astro/*.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser
            }
        },
        rules: {
            'no-alert': 0
        }
    }
]);
