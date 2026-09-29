import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const frameworkModules = [
  '@nestjs/*',
  '@prisma/*',
  'mercadopago',
  'class-validator',
  'class-transformer',
  'nestjs-pino',
  'pino',
  'pino-http',
  'express',
  'helmet',
];
// Folder-level patterns also catch barrel imports such as '../../infrastructure'.
const outerLayers = ['**/infrastructure', '**/presentation', '**/generated'];

// In flat config a later block replaces the whole rule entry, so both layers are built from one helper.
const layerRule = (forbidden, message) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: frameworkModules,
          message: 'Domain and application stay framework-free (Clean Architecture).',
        },
        { group: forbidden, message },
      ],
    },
  ],
});

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-properties': [
        'error',
        { property: '$queryRawUnsafe', message: 'Use the parameterised $queryRaw tagged template.' },
        { property: '$executeRawUnsafe', message: 'Use the parameterised $executeRaw tagged template.' },
        { object: 'Prisma', property: 'raw', message: 'Prisma.raw bypasses parameterisation.' },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  { files: ['test/**'], languageOptions: { globals: globals.jest } },
  {
    files: ['src/application/**/*.ts'],
    rules: layerRule(outerLayers, 'Application must not import outer layers.'),
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: layerRule(['**/application', ...outerLayers], 'Domain imports nothing outside domain.'),
  },
  {
    // Presentation may use Nest, but reaches persistence and configuration only through the composition root.
    files: ['src/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure', '**/generated', '@prisma/*'],
              message: 'Presentation depends on application and domain only.',
            },
          ],
        },
      ],
    },
  },
);
