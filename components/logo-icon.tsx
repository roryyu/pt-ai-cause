/**
 * 品牌 Logo 图标
 * 紫色线团落在金黄色等距基座上，体现"归因"——在数据基座中梳理线索、定位核心结论的产品意象。
 * 图片为透明底 PNG（public/logo.png），favicon 同源（app/icon.png）。
 */
export function LogoIcon({
  className,
  size = 24,
}: {
  className?: string;
  size?: number;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 品牌位图为静态小图，无需 next/image 优化
    <img
      src="/logo.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
