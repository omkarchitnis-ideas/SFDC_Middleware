"""
Official Python MCP Client Verification for Ohm Agent
Connects to SFDC MCP Server (http://localhost:4005/sse) using official 'mcp' SDK
"""

import asyncio
import json
from mcp import ClientSession
from mcp.client.sse import sse_client

async def main():
    print("Connecting to SFDC MCP Server over SSE (http://localhost:4005/sse)...")
    async with sse_client("http://localhost:4005/sse") as (read, write):
        async with ClientSession(read, write) as session:
            init_result = await session.initialize()
            print(f"[OK] MCP Session Initialized! Protocol Version: {init_result.protocol_version}")

            # 1. Discover Tools
            tools_response = await session.list_tools()
            tools = tools_response.tools
            print(f"\n[OK] Discovered {len(tools)} Registered MCP Tools:")
            for t in tools:
                print(f"   * {t.name}: {t.description[:70]}...")

            # 2. Call Tool: sfdc_get_case
            print("\n[Executing Tool: sfdc_get_case for Case '03357264']...")
            case_call = await session.call_tool("sfdc_get_case", {"case_number": "03357264", "include_comments": True})
            case_data = json.loads(case_call.content[0].text)
            print(f"   * Found:       {case_data.get('found')}")
            print(f"   * Case Number: {case_data.get('case_number')}")
            print(f"   * Subject:     {case_data.get('subject')}")
            print(f"   * Status:      {case_data.get('status')} | Priority: {case_data.get('priority')}")
            print(f"   * Owner:       {case_data.get('owner_name')}")
            print(f"   * Query Time:  {case_data.get('_query_time_ms')}ms")

            # 3. Call Tool: sfdc_resolve_user
            print("\n[Executing Tool: sfdc_resolve_user for 'Omkar Chitnis']...")
            user_call = await session.call_tool("sfdc_resolve_user", {"query": "Omkar Chitnis"})
            user_data = json.loads(user_call.content[0].text)
            print(f"   * Users Found: {user_data.get('count')}")
            for u in user_data.get("users", []):
                print(f"     -> {u.get('name')} | Email: {u.get('email')} | Active: {u.get('is_active')}")

            # 4. Call Tool: sfdc_get_team_workload
            print("\n[Executing Tool: sfdc_get_team_workload]...")
            wl_call = await session.call_tool("sfdc_get_team_workload", {})
            wl_data = json.loads(wl_call.content[0].text)
            print(f"   * Active Queues/Teams: {len(wl_data.get('workload', []))}")
            if wl_data.get("workload"):
                print(f"   * Top Queue: {wl_data['workload'][0].get('team_member')} (Active Tasks: {wl_data['workload'][0].get('active_tasks')})")

            # 5. Call Tool: sfdc_query_clone
            print("\n[Executing Tool: sfdc_query_clone (SELECT count(*) FROM users)]...")
            q_call = await session.call_tool("sfdc_query_clone", {"sql": "SELECT count(*) AS total_users, is_active FROM users GROUP BY is_active;"})
            q_data = json.loads(q_call.content[0].text)
            print(f"   * Query Clone Rows: {q_data.get('rows')}")

            # 6. Read Resource: sfdc://system/stats
            print("\n[Reading Resource: sfdc://system/stats]...")
            stats_res = await session.read_resource("sfdc://system/stats")
            stats_data = json.loads(stats_res.contents[0].text)
            print(f"   * System Counts: {stats_data.get('counts')}")

            print("\n" + "=" * 75)
            print("SUCCESS: Official Python MCP SDK Verified! Ohm Agent Ready to Connect.")
            print("=" * 75)

if __name__ == "__main__":
    asyncio.run(main())
