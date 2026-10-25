import { Alert, App, Button, Form, Input, Steps, Tag, Typography } from "antd";
import { ExportOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useSearchParams } from "react-router-dom";
import { errorMessage, useAuthStatus, useLoginUrl, useSetSession } from "../api/client";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import BreezeData from "../components/BreezeData";

const { Text } = Typography;

const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

export default function SessionPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ session_token: string }>();
  const status = useAuthStatus();
  const loginUrl = useLoginUrl();
  const setSession = useSetSession();
  const [params] = useSearchParams();

  const onSubmit = ({ session_token }: { session_token: string }) =>
    setSession.mutate(session_token.trim(), {
      onSuccess: () => {
        message.success("Connected to Breeze");
        form.resetFields();
      },
    });

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <PageTitle title="Session" description="Breeze sessions expire daily. Log in once each trading day." pageTitle={[{ title: "Session" }]} />

      {/* Set by the backend's /auth/callback redirect after ICICI login. */}
      {params.get("connected") && <Alert type="success" showIcon message="Logged in to Breeze through the redirect" />}
      {params.get("error") && <Alert type="error" showIcon message="Breeze login failed" description={params.get("error")} />}

      <SectionCard
        title="Connection status"
        description="State of the server's Breeze session."
        extra={<Tag color={status.data?.connected ? "success" : "warning"}>{status.data?.connected ? "Connected" : "Not connected"}</Tag>}
      >
        <Text type="secondary" className="text-xs">
          {status.data?.connected
            ? `Connected at ${dayjs(status.data.connected_at).format("HH:mm:ss, D MMM YYYY")}. The token is cached in .breeze_session for restarts today.`
            : "No active session. Follow the steps below."}
        </Text>
      </SectionCard>

      <SectionCard title="Log in to ICICI Direct" description="Get today's apisession token from the Breeze login page.">
        <Steps
          direction="vertical"
          size="small"
          items={[
            { title: "Open the login page", description: "Log in with your ICICI Direct user ID, password and OTP." },
            {
              title: "Get redirected",
              description: (
                <span>
                  ICICI sends the apisession token to your app's redirect URL. If that URL is{" "}
                  <code style={mono}>http://127.0.0.1:8000/auth/callback</code>, the server connects and brings you back here.
                </span>
              ),
            },
            { title: "Otherwise paste the token", description: "Copy the apisession value into the form below." },
          ].map((step) => ({ ...step, status: "process" as const }))}
        />
        <Button type="primary" icon={<ExportOutlined />} href={loginUrl.data?.login_url} target="_blank" disabled={!loginUrl.data} className="mt-2">
          Open Breeze login
        </Button>
      </SectionCard>

      <SectionCard title="Session token" description="Paste the apisession value from the redirect URL.">
        <Form form={form} layout="vertical" onFinish={onSubmit}>
          <Form.Item name="session_token" label="apisession" rules={[{ required: true, message: "Paste the token" }]}>
            <Input placeholder="e.g. 12345678" style={mono} autoComplete="off" />
          </Form.Item>
          {setSession.error && <Alert className="mb-4" type="error" showIcon message={errorMessage(setSession.error)} />}
          <Form.Item className="mb-0">
            <Button type="primary" htmlType="submit" loading={setSession.isPending}>
              Connect
            </Button>
          </Form.Item>
        </Form>
      </SectionCard>

      {setSession.data?.customer && (
        <SectionCard title="Customer details" description="Returned by get_customer_details for this session.">
          <BreezeData data={setSession.data.customer} />
        </SectionCard>
      )}
    </div>
  );
}
