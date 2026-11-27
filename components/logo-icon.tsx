/**
 * 品牌 Logo 图标
 * 紫色线团与金黄色线头，体现"归因"——梳理线索、定位核心结论的产品意象。
 * 图片为满幅紫底方形 PNG（public/logo.png），favicon 同源（app/icon.png），圆角渲染为应用图标样式。
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
      style={{ borderRadius: Math.round(size * 0.22) }}
    />
  );
}
