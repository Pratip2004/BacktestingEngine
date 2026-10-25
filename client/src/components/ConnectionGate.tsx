import { Alert, Button } from "antd";
import { Link } from "react-router-dom";
import { useAuthStatus } from "../api/client";

// Shows a login prompt in place of children when there's no Breeze session.
export default function ConnectionGate({ children }: { children: React.ReactNode }) {
  const { data } = useAuthStatus();
  if (data?.connected) return <>{children}</>;
  return (
    <Alert
      type="warning"
      showIcon
      message="Not connected to Breeze"
      description="This needs today's Breeze session. Log in from the Session page."
      action={
        <Link to="/session">
          <Button size="small" type="primary">
            Go to session
          </Button>
        </Link>
      }
    />
  );
}
