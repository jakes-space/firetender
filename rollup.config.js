import typescript from 'rollup-plugin-typescript2';

export default {
  input: 'src/FireTender.ts',
  output: [
    {
      file: "dest/index.js",
      format: "es",
      sourcemap: false,
    },
    {
      file: "dest/index.cjs",
      format: "cjs",
      sourcemap: false,
    },
  ],
  plugins: [
    typescript({
      tsconfig: "tsconfig.json",
      sourceMap: false,
    })
  ]
}