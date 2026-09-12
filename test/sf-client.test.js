const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isSelectOnly, flattenRecord } = require('../sf-client');

describe('sf-client security & data transformations', () => {

  describe('isSelectOnly()', () => {
    test('allows standard SELECT queries', () => {
      assert.strictEqual(isSelectOnly('SELECT Id, Subject FROM Task'), true);
      assert.strictEqual(isSelectOnly('select id, status from case where status = "Open"'), true);
      assert.strictEqual(isSelectOnly('SELECT  Id,  (SELECT Id FROM Contacts)  FROM Account'), true);
      assert.strictEqual(isSelectOnly('\n  SELECT Id,\n  Name\n  FROM User\n'), true);
    });

    test('allows SELECT queries containing DML keywords inside string literals', () => {
      assert.strictEqual(isSelectOnly("SELECT Id FROM Task WHERE Status = 'DELETE'"), true);
      assert.strictEqual(isSelectOnly("SELECT Id FROM Task WHERE Subject LIKE '%UPDATE%'"), true);
      assert.strictEqual(isSelectOnly("SELECT Id FROM Case WHERE Reason = 'INSERT INTO database'"), true);
      assert.strictEqual(isSelectOnly("SELECT Id FROM Case WHERE Description = 'DROP TABLE tasks'"), true);
    });

    test('rejects DML statements', () => {
      assert.strictEqual(isSelectOnly("INSERT INTO Task (Subject) VALUES ('Test')"), false);
      assert.strictEqual(isSelectOnly("UPDATE Task SET Status = 'Closed' WHERE Id = '123'"), false);
      assert.strictEqual(isSelectOnly("DELETE FROM Task WHERE Id = '123'"), false);
      assert.strictEqual(isSelectOnly("UPSERT Task Target_Id__c"), false);
      assert.strictEqual(isSelectOnly("MERGE Account TargetId SourceId"), false);
      assert.strictEqual(isSelectOnly("UNDELETE Case WHERE Id = '123'"), false);
    });

    test('rejects DDL statements', () => {
      assert.strictEqual(isSelectOnly("CREATE TABLE users (id INT)"), false);
      assert.strictEqual(isSelectOnly("DROP TABLE tasks"), false);
      assert.strictEqual(isSelectOnly("ALTER TABLE tasks ADD COLUMN age INT"), false);
    });

    test('rejects multi-statement or injected queries', () => {
      assert.strictEqual(isSelectOnly("SELECT Id FROM Task; DELETE FROM Task;"), false);
      assert.strictEqual(isSelectOnly("SELECT Id FROM Task UNION ALL UPDATE Task SET Status='Closed'"), false);
      assert.strictEqual(isSelectOnly("UPDATE Task SET Subject='x'; SELECT Id FROM Task"), false);
    });

    test('handles invalid or empty inputs gracefully', () => {
      assert.strictEqual(isSelectOnly(''), false);
      assert.strictEqual(isSelectOnly(null), false);
      assert.strictEqual(isSelectOnly(undefined), false);
      assert.strictEqual(isSelectOnly('SHOW TABLES'), false);
    });
  });

  describe('flattenRecord()', () => {
    test('leaves flat records intact', () => {
      const input = { Id: '001', Subject: 'Test Task', Status: 'Open' };
      const output = flattenRecord(input);
      assert.deepStrictEqual(output, { Id: '001', Subject: 'Test Task', Status: 'Open' });
    });

    test('flattens single-relationship objects and removes attributes metadata', () => {
      const input = {
        Id: '001',
        attributes: { type: 'Task', url: '/services/data/v60.0/sobjects/Task/001' },
        Owner: {
          attributes: { type: 'Name', url: '/services/data/v60.0/sobjects/User/002' },
          Name: 'Omkar Chitnis'
        }
      };
      const output = flattenRecord(input);
      assert.deepStrictEqual(output, {
        Id: '001',
        'Owner.Name': 'Omkar Chitnis'
      });
    });

    test('flattens deeply nested relationship structures', () => {
      const input = {
        Task_Number__c: 'T-100',
        What: {
          attributes: { type: 'Case' },
          CaseNumber: 'C-200',
          Account: {
            attributes: { type: 'Account' },
            Account_Chain_Code__c: 'SCAN'
          }
        }
      };
      const output = flattenRecord(input);
      assert.deepStrictEqual(output, {
        Task_Number__c: 'T-100',
        'What.CaseNumber': 'C-200',
        'What.Account.Account_Chain_Code__c': 'SCAN'
      });
    });

    test('collapses child relationship record arrays to summary strings', () => {
      const inputSingle = {
        Id: '001',
        Tasks: {
          records: [{ Id: 't1' }]
        }
      };
      assert.deepStrictEqual(flattenRecord(inputSingle), {
        Id: '001',
        Tasks: '[1 related record]'
      });

      const inputMultiple = {
        Id: '001',
        Tasks: {
          records: [{ Id: 't1' }, { Id: 't2' }, { Id: 't3' }]
        }
      };
      assert.deepStrictEqual(flattenRecord(inputMultiple), {
        Id: '001',
        Tasks: '[3 related records]'
      });
    });

    test('handles standard arrays by JSON stringifying them', () => {
      const input = { Id: '001', Tags: ['urgent', 'review'] };
      const output = flattenRecord(input);
      assert.deepStrictEqual(output, {
        Id: '001',
        Tags: '["urgent","review"]'
      });
    });

    test('preserves null, undefined, boolean, and numeric values', () => {
      const input = {
        Id: '001',
        NullVal: null,
        ZeroVal: 0,
        BoolVal: false,
        EmptyString: ''
      };
      const output = flattenRecord(input);
      assert.deepStrictEqual(output, {
        Id: '001',
        NullVal: null,
        ZeroVal: 0,
        BoolVal: false,
        EmptyString: ''
      });
    });
  });

});
