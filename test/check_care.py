import sqlite3

conn = sqlite3.connect('salesforce_data.db')
cur = conn.cursor()
cur.execute("SELECT Task_Number, Assigned, Last_Modified_By, Last_Modified_Time, Last_Modified_Date, Date FROM tasks WHERE Assigned LIKE '%CARE%' LIMIT 10")
rows = cur.fetchall()
for r in rows:
    print(r)
conn.close()
