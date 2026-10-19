// Architectural guardrails: keep the dedup work in lib/pdfHtml.js and
// lib/upload.js from regressing, and surface routes that bypass a data layer.
module.exports = [
  {
    ignores: ['node_modules/**', 'graphify-out/**', 'public/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
  },
  {
    files: ['lib/*Pdf.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "FunctionDeclaration[id.name='esc']", message: 'Import esc() from lib/pdfHtml.js instead of redefining it.' },
        { selector: "FunctionDeclaration[id.name='fmt']", message: 'Import fmt() from lib/pdfHtml.js instead of redefining it.' },
      ],
    },
  },
  {
    files: ['routes/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='multer'][callee.property.name='diskStorage']", message: 'Use makeUpload() from lib/upload.js instead of calling multer.diskStorage() directly.' },
        { selector: "CallExpression[callee.object.name='multer'][callee.property.name='memoryStorage']", message: 'Use uploadMemory from lib/upload.js instead of calling multer.memoryStorage() directly.' },
      ],
      // no-restricted-imports only matches ES `import`; this project is CommonJS
      // (require()), so the db-handle check needs the CJS-specific rule instead.
      'no-restricted-modules': [
        'warn',
        { name: '../db', message: 'Route imports the raw db handle directly. Matches the existing architecture for now (warn-only), but prefer a repository/service layer for new code where practical.' },
      ],
    },
  },
];
