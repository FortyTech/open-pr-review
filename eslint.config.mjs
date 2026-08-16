import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// eslint-config-next 16 ships flat config directly. Going through FlatCompat
// instead throws "Converting circular structure to JSON" when it tries to
// serialise the plugin graph for validation.
const config = [
  ...coreWebVitals,
  ...typescript,
  { ignores: ['.next/**', 'node_modules/**'] },
];

export default config;
