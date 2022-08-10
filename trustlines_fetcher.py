from xrpl.models.requests import AccountLines
from xrpl.clients import JsonRpcClient

def get_all_holders(w3, currency, issuer):
    """get_all_holders."""
    holders = {}
    marker = None
    has_marker = True
    page = 1
    tl = 1
    print('SNAPSHOT {} FOR {}'.format(currency, issuer))
    while has_marker:
        print('PAGINATION: PAGE: {}'.format(page))
        acct_lines = AccountLines(
            account=issuer,
            ledger_index="current",
            limit=1000,
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
    return holders, tl

json_client = JsonRpcClient('https://s2.ripple.com:51234/')
holders,tl = get_all_holders(json_client, '47726579686F756E640000000000000000000000', 'rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ')
toBeWritten = {'tl': tl, 'holders': holders}
import json
with open('trustlines_data.json', 'w') as f:
    json.dump(toBeWritten, f, indent=4)
