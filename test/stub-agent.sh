#!/bin/bash
# Stub for the claude CLI: consumes the prompt and replies in stream-json. Behaviour comes from files in the campaign.
cat > /dev/null
mode="$(cat "$ARC_CAMPAIGN_DIR/stub-mode" 2>/dev/null || echo ok)"
echo '{"type":"system","subtype":"init","model":"stub-model"}'
if [ "$mode" = fail ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Your workspace is out of credits"}'
  exit 1
fi
report="$(cat "$ARC_CAMPAIGN_DIR/stub-report-$ARC_ROLE" 2>/dev/null || echo "$ARC_ROLE turn done")"
node -e 'console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:process.argv[1],total_cost_usd:0.01,usage:{input_tokens:10,cache_read_input_tokens:90,output_tokens:5}}))' "$report"
