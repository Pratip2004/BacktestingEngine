import { Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useAuthStatus, useFunds, useHoldings, usePositions } from "../api/client";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import BreezeData from "../components/BreezeData";
import ConnectionGate from "../components/ConnectionGate";

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return <Button size="small" icon={<ReloadOutlined />} onClick={onClick} loading={loading} />;
}

export default function AccountPage() {
  const connected = !!useAuthStatus().data?.connected;
  const funds = useFunds(connected);
  const holdings = useHoldings(connected);
  const positions = usePositions(connected);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <PageTitle title="Account" description="Read-only view of your ICICI Direct account." pageTitle={[{ title: "Account" }]} />

      <ConnectionGate>
        <SectionCard
          title="Funds"
          description="Bank balance and segment allocations (get_funds)."
          extra={<RefreshButton onClick={() => funds.refetch()} loading={funds.isFetching} />}
        >
          <BreezeData data={funds.data} loading={funds.isLoading} error={funds.error} />
        </SectionCard>

        <SectionCard
          title="Demat holdings"
          description="Stocks held in demat (get_demat_holdings)."
          extra={<RefreshButton onClick={() => holdings.refetch()} loading={holdings.isFetching} />}
        >
          <BreezeData data={holdings.data} loading={holdings.isLoading} error={holdings.error} emptyText="No holdings" />
        </SectionCard>

        <SectionCard
          title="Open positions"
          description="Intraday and F&O positions (get_portfolio_positions)."
          extra={<RefreshButton onClick={() => positions.refetch()} loading={positions.isFetching} />}
        >
          <BreezeData data={positions.data} loading={positions.isLoading} error={positions.error} emptyText="No open positions" />
        </SectionCard>
      </ConnectionGate>
    </div>
  );
}
