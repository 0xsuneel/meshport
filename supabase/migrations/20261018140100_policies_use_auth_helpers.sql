-- Access rules no longer read users.auth_uid as the caller: they ask the
-- security-definer helpers from 20261018140000 instead. Same rules as
-- before, so users.auth_uid can later be hidden from anon/authenticated.

-- activity / ub_claim_intents (by wallet; unbound accounts stay open as before)
alter policy activity_insert on public.activity with check (public.session_may_use_wallet(wallet_address));
alter policy activity_select on public.activity using (public.session_may_use_wallet(wallet_address));
alter policy activity_update on public.activity using (public.session_may_use_wallet(wallet_address));
alter policy ub_claim_intents_insert on public.ub_claim_intents
  with check ((status = 'waiting'::text) and public.session_may_use_wallet(wallet_address));
alter policy ub_claim_intents_select on public.ub_claim_intents using (public.session_may_use_wallet(wallet_address));

-- by user id (text-compared; unbound accounts stay open as before)
alter policy contacts_delete on public.contacts using (public.session_may_use_user(owner_id::text));
alter policy contacts_insert on public.contacts with check (public.session_may_use_user(owner_id::text));
alter policy contacts_select on public.contacts using (public.session_may_use_user(owner_id::text));
alter policy contacts_update on public.contacts using (public.session_may_use_user(owner_id::text));
alter policy dtr_insert on public.daily_tx_rewards with check (public.session_may_use_user(user_id));
alter policy dtr_select on public.daily_tx_rewards using (public.session_may_use_user(user_id));
alter policy dtr_update on public.daily_tx_rewards using (public.session_may_use_user(user_id));
alter policy pt_insert on public.point_transactions
  with check ((reason <> 'claim_reserved'::text) and ((points >= 0) and (points <= 20)) and public.session_may_use_user(user_id));
alter policy pt_select on public.point_transactions using (public.session_may_use_user(user_id));
alter policy rc_insert on public.reward_claims with check (public.session_may_use_user(user_id));
alter policy rc_select on public.reward_claims using (public.session_may_use_user(user_id));
alter policy rc_update on public.reward_claims using (public.session_may_use_user(user_id));
alter policy points_select on public.user_points using (public.session_may_use_user(user_id));

-- bound to this session only
alter policy chat_blocks_delete on public.chat_blocks using (owner_id = any ((select public.my_user_ids())::uuid[]));
alter policy chat_blocks_insert on public.chat_blocks with check (owner_id = any ((select public.my_user_ids())::uuid[]));
alter policy chat_blocks_select on public.chat_blocks using (owner_id = any ((select public.my_user_ids())::uuid[]));

alter policy conv_insert on public.conversations
  with check (participant_a = any ((select public.my_user_ids())::uuid[]) or participant_b = any ((select public.my_user_ids())::uuid[]));
alter policy conv_select on public.conversations
  using (participant_a = any ((select public.my_user_ids())::uuid[]) or participant_b = any ((select public.my_user_ids())::uuid[]));
alter policy conv_update on public.conversations
  using (participant_a = any ((select public.my_user_ids())::uuid[]) or participant_b = any ((select public.my_user_ids())::uuid[]))
  with check (participant_a = any ((select public.my_user_ids())::uuid[]) or participant_b = any ((select public.my_user_ids())::uuid[]));

alter policy msg_delete on public.messages using (sender_id = any ((select public.my_user_ids())::uuid[]));
alter policy msg_insert on public.messages
  with check ((type = 'text'::text)
    and sender_id = any ((select public.my_user_ids())::uuid[])
    and (exists (select 1 from public.conversations c
                  where c.id = messages.conversation_id
                    and (messages.sender_id = c.participant_a or messages.sender_id = c.participant_b)))
    and (not public.chat_blocked_in(conversation_id, sender_id)));
alter policy msg_select on public.messages
  using (exists (select 1 from public.conversations c
                  where c.id = messages.conversation_id
                    and (c.participant_a = any ((select public.my_user_ids())::uuid[]) or c.participant_b = any ((select public.my_user_ids())::uuid[]))));
alter policy msg_update on public.messages
  using (exists (select 1 from public.conversations c
                  where c.id = messages.conversation_id
                    and (c.participant_a = any ((select public.my_user_ids())::uuid[]) or c.participant_b = any ((select public.my_user_ids())::uuid[]))));

alter policy push_subscriptions_delete_owner on public.push_subscriptions using (user_id = any ((select public.my_user_ids())::uuid[]));
alter policy push_subscriptions_insert_owner on public.push_subscriptions with check (user_id = any ((select public.my_user_ids())::uuid[]));
alter policy push_subscriptions_select_owner on public.push_subscriptions using (user_id = any ((select public.my_user_ids())::uuid[]));
alter policy push_subscriptions_update_owner on public.push_subscriptions
  using (user_id = any ((select public.my_user_ids())::uuid[])) with check (user_id = any ((select public.my_user_ids())::uuid[]));

alter policy wallet_passkeys_delete on public.wallet_passkeys using (user_id = any ((select public.my_user_ids())::uuid[]));
alter policy wallet_passkeys_insert on public.wallet_passkeys
  with check (user_id = any ((select public.my_user_ids())::uuid[])
    and exists (select 1 from public.users u
                 where u.id = wallet_passkeys.user_id
                   and lower(u.wallet_address) = lower(wallet_passkeys.wallet_address)));
alter policy wallet_passkeys_select on public.wallet_passkeys using (user_id = any ((select public.my_user_ids())::uuid[]));

alter policy users_update on public.users
  using (id = any ((select public.my_user_ids())::uuid[])) with check (id = any ((select public.my_user_ids())::uuid[]));

alter policy mcr_select_business on public.merchant_chain_receipts
  using (merchant_wallet = any ((select public.my_business_wallets())::text[]));

alter policy mr_select_customer on public.merchant_refunds
  using ((customer_user_id is not null) and customer_user_id = any ((select public.my_user_ids())::text[]));

