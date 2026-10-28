import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // demo/ is a separate Next.js project with its own lint config.
  { ignores: ["demo/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // eslint-plugin-react-hooks 7.1 起该规则对手写的 useCallback/useMemo 报「编译器会跳过此处」；
      // 本项目不启用 React Compiler，提示没有实际意义，与上面三条 Compiler 规则同理关闭。
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default eslintConfig;
