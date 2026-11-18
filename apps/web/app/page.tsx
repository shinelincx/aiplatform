import { checkApiHealth } from '@ado/shared';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const reachable = await checkApiHealth(process.env.API_BASE_URL ?? 'http://127.0.0.1:3101');
  return (
    <>
      <header><strong>ADO</strong><span>研发管理平台</span></header>
      <main>
        <h1>开发环境状态</h1>
        <dl>
          <div><dt>Web 控制台</dt><dd>运行中</dd></div>
          <div><dt>控制面 API</dt><dd data-offline={!reachable}>{reachable ? '连接正常' : '连接失败'}</dd></div>
        </dl>
        <form action="/"><button type="submit">重新检查</button></form>
      </main>
    </>
  );
}
