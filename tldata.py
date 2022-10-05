import pprint
from xrpl.models.requests import AccountLines,AccountTx
from xrpl.utils import get_balance_changes
from xrpl.clients import JsonRpcClient
import datetime
import json

json_client = JsonRpcClient('https://s2.ripple.com:51234/')

def get_all_holders(w3, currency, issuer):
        """get_all_holders."""
        holders = {}
        marker = None
        has_marker = True
        page = 1
        tl = 1
        zeroTl = 1
        zeroHolder = {}
        print('SNAPSHOT {} FOR {}'.format(currency, issuer))
        while has_marker:
            print('PAGINATION: PAGE: {}'.format(page))
            acct_lines = AccountLines(
                account=issuer,
                ledger_index="current",
                limit=10000,
                marker=marker,
            )
            response = w3.request(acct_lines)

            if 'status' in response.result and response.result['status'] == 'error':  # noqa
                raise ValueError(response.result['error_message'])

            for line in response.result['lines']:
                if line['currency'] != currency:
                    # print('SKIPPING WRONG CURRENCY')
                    continue
                
                if float(abs(float(line['balance']))) < 1:
                    # print('SKIPPING NEGATIVE OR 0 BALANCE')
                    zeroTl += 1
                    zeroHolder[line['account']] = {
                        'limit': int(abs(float(line['limit_peer']))),
                        'balance': int(abs(float(line['balance']))),
                    }
                    tl += 1
                    continue
                holders[line['account']] = {
                    'limit': int(abs(float(line['limit_peer']))),  # noqa
                    'balance': int(abs(float(line['balance']))),  # noqa
                }
                tl += 1

            if 'marker' in response.result:
                marker = response.result['marker']
                page += 1
                continue
            has_marker = False
        print('FINISHED PAGINATION')
        return holders, tl, zeroTl
 
def convertRippleTimeToUnixTime(time):
    return int(time) + 946684800

def convertUnixTimeToUTC(time):
    return datetime.datetime.utcfromtimestamp(time).strftime('%Y-%m-%d %H:%M:%S')

def get30dayTransactions(account,month,marker):
    has_marker = True
    addys = []
    txn_count = 0
    page = 1
    newTl = 0
    oneYear = 31536000
    while has_marker:
        print('PAGINATION: PAGE: {}'.format(page))
        txns = AccountTx(
            account=account,
            limit=1000, 
            marker=marker
        )
        response = json_client.request(txns)
        for txn in response.result['transactions']:
            time = txn['tx']['date']
            utcTime = convertUnixTimeToUTC(convertRippleTimeToUnixTime(time))
            txn_count += 1
            if txn['tx']['TransactionType'] == 'TrustSet':
                if float(txn['tx']['LimitAmount']['value']) != 0:
                    toCheck = datetime.datetime.strptime(utcTime, '%Y-%m-%d %H:%M:%S')
                    if month == 1:
                        print('month: ', toCheck.month)
                    if month == toCheck.month:
                        newTl += 1
                        addys.append(txn['tx']['Account'])
                        # print('NEW TRUSTLINE: {} {} {}'.format(txn['tx']['Account'],txn['tx']['LimitAmount']['value'],utcTime))
                    if toCheck.month < month:
                        has_marker = False
                        return newTl,addys,marker
                    if month == 1 and toCheck.month == 12:
                        has_marker = False
                        return newTl,addys,marker
                    # addys.append(txn['tx']['Account'])
                    # newTl += 1
            # date before 12 months of current date
            if convertRippleTimeToUnixTime(time) < (int(datetime.datetime.now().timestamp()) - oneYear):
                print(utcTime)
                print(newTl)
                has_marker = False
                return newTl,addys,marker
        if 'marker' in response.result:
            marker = response.result['marker']
            page += 1
            print('HAS MARKER')
            continue
        has_marker = False

if __name__== '__main__':
    # newTls,addys = get30dayTransactions('rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ',8)
    months = []
    curMonth = datetime.datetime.now().month
    for i in range(1,curMonth + 1):
        months.append(i)
    months.reverse()
    print(months)
    monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
    monthTlDict = {}
    marker = None
    for month in months:
        newTls,addys,marker = get30dayTransactions('rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ',month,marker)
        print('NEW TLs: {} for month: {}'.format(newTls,month))
        monthTlDict[monthNames[month-1]] = newTls
    mainDict = {
        "tlData": monthTlDict
    }
    with open('tls.json', 'w') as outfile:
        json.dump(monthTlDict, outfile)
    totalHolders,Tls,zeroTls = get_all_holders(json_client,'47726579686F756E640000000000000000000000','rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ')
    mainDict['totalTls'] = Tls
    mainDict['totalHolders'] = Tls - zeroTls
    totalholders = Tls - zeroTls
    holderDict = {}
    for month in months:
        holderDict[monthNames[month-1]] = 0
    mainDict['holderData'] = holderDict
    for month in holderDict:
        holderDict[month] = totalholders - monthTlDict[month]
        totalholders = totalholders - monthTlDict[month]
    with open('tls.json', 'w') as outfile:
        json.dump(mainDict, outfile, indent=4)