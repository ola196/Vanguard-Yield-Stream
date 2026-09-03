use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};
use vanguard_stream::{Error, VanguardStreamContract, VanguardStreamContractClient};

#[test]
fn cancelled_stream_is_settled_and_cannot_be_withdrawn() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();
    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &100_000_000);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|ledger| ledger.timestamp = 100);
    let stream_id = client.create_stream(&sender, &recipient, &100_000_000, &200, &1_200);

    env.ledger().with_mut(|ledger| ledger.timestamp = 600);
    client.cancel_stream(&stream_id);

    assert_eq!(client.balance_of(&stream_id), 0);
    assert_eq!(token_client.balance(&recipient), 50_000_000);
    assert_eq!(token_client.balance(&sender), 50_000_000);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(client.try_withdraw(&stream_id, &1), Err(Ok(Error::StreamCancelled)));
}