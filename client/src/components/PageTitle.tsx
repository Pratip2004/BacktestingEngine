import { useEffect } from "react";
import { Breadcrumb, Typography } from "antd";
import { Link } from "react-router-dom";

const { Title, Text } = Typography;

export default function PageTitle({
  title,
  description,
  pageTitle,
}: {
  title: string;
  description?: string;
  pageTitle: { title: string; link?: string }[];
}) {
  useEffect(() => {
    document.title = `${title} · Backtesting Engine`;
  }, [title]);

  return (
    <div className="mb-5">
      <Breadcrumb
        className="mb-2"
        items={[{ title: <Link to="/">Home</Link> }, ...pageTitle].map((p) =>
          "link" in p && p.link ? { title: <Link to={p.link}>{p.title}</Link> } : { title: p.title },
        )}
      />
      <Title level={4} className="!mb-1 !text-[20px] !font-semibold">
        {title}
      </Title>
      {description && (
        <Text type="secondary" className="text-xs">
          {description}
        </Text>
      )}
    </div>
  );
}
