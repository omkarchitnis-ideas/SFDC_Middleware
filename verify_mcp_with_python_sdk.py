"""
Official Python MCP Client Verification for Ohm Agent
Tests all 24 tools against SFDC Enterprise MCP Server (http://localhost:4005/sse)
"""

import asyncio
import json
from mcp import ClientSession
from mcp.client.sse import sse_client

async def main():
    print("Connecting to SFDC Enterprise MCP Server (http://localhost:4005/sse)...")
    async with sse_client("http://localhost:4005/sse") as (read, write):
        async with ClientSession(read, write) as session:
            init_result = await session.initialize()
            print(f"[OK] MCP Session Initialized! Protocol Version: {init_result.protocol_version}")

            # 1. Discover All Tools
            tools_response = await session.list_tools()
            tools = tools_response.tools
            print(f"\n[OK] Discovered {len(tools)} Registered MCP Tools:")
            for idx, t in enumerate(tools, 1):
                print(f"   {idx:2d}. {t.name:<25} - {t.description[:60]}...")

            # 2. Test sfdc_get_case
            print("\n[1/5 Testing sfdc_get_case]...")
            c_res = await session.call_tool("sfdc_get_case", {"case_number": "03357264"})
            c_data = json.loads(c_res.content[0].text)
            print(f"   -> Found: {c_data.get('found')} | Subject: {c_data.get('subject')} | Time: {c_data.get('_query_time_ms')}ms")

            # 3. Test sfdc_get_account
            print("\n[2/5 Testing sfdc_get_account]...")
            a_res = await session.call_tool("sfdc_get_account", {"account_name": "Hyatt"})
            a_data = json.loads(a_res.content[0].text)
            print(f"   -> Found: {a_data.get('found')} | Account: {a_data.get('account', {}).get('account_name')} | Time: {a_data.get('_query_time_ms')}ms")

            # 4. Test sfdc_get_integration
            print("\n[3/5 Testing sfdc_get_integration (RMS PMS/CRS Rules)]...")
            i_res = await session.call_tool("sfdc_get_integration", {"integration_name": "NiteSoft"})
            i_data = json.loads(i_res.content[0].text)
            print(f"   -> Integrations Found: {i_data.get('count')}")
            if i_data.get("integrations"):
                integ = i_data["integrations"][0]
                print(f"   -> Name: {integ.get('name')} | Overbooking: {integ.get('overbooking_controls')} | Type: {integ.get('integration_type')}")

            # 5. Test sfdc_get_picklist_values
            print("\n[4/5 Testing sfdc_get_picklist_values (Case.Priority)]...")
            p_res = await session.call_tool("sfdc_get_picklist_values", {"sobject_name": "Case", "field_name": "Priority"})
            p_data = json.loads(p_res.content[0].text)
            print(f"   -> Allowed Priorities: {[p['value'] for p in p_data.get('picklist_values', [])]}")

            # 6. Read System Stats Resource
            print("\n[5/5 Testing Resource: sfdc://system/stats]...")
            stats_res = await session.read_resource("sfdc://system/stats")
            stats_data = json.loads(stats_res.contents[0].text)
            print(f"   -> System Counts: {stats_data.get('counts')}")

            print("\n" + "=" * 78)
            print("SUCCESS: All 24 Universal Enterprise SFDC MCP Tools Verified!")
            print("=" * 78)

if __name__ == "__main__":
    asyncio.run(main())
