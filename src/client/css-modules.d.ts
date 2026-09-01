/** CSS Modules 的类名映射类型（构建期由 lightningcss 生成真实哈希类名）。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
