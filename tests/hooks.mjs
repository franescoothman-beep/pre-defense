// tests/hooks.mjs —— Node 测试运行器要求 ESM 相对导入带扩展名，Next 的 bundler 不需要。
// 用 Node 24 的同步解析钩子（registerHooks）在测试侧补 .ts，
// 产品代码保持 Next 友好的导入写法，不为了测试牺牲打包兼容性。
//
// 用法：node --import ./tests/hooks.mjs --test "tests/*.test.ts"
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {
          /* 试下一个后缀 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
