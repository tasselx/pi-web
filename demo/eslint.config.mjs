import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      // 与主应用的 eslint 配置一致：demo 里的组件是主应用的拷贝，在主应用里这条规则是关闭的
      // （本项目不启用 React Compiler，手写的 useCallback/useMemo 不会被编译器接管）。
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
