#!/bin/bash

# Monitor mech worker for critical failures
# Kills process if stuck, looping, or failing repeatedly

LOG_FILE="${1:-/Users/gcd/.cursor/projects/Users-gcd-Repositories-main-jinn-cli-agents/terminals/1.txt}"
CHECK_INTERVAL=300  # 5 minutes in seconds

echo "[$(date)] Mech monitor started - checking every $CHECK_INTERVAL seconds"
echo "Monitoring log: $LOG_FILE"
echo "---"

check_and_kill() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "[$(date)] Log file not found: $LOG_FILE"
        return
    fi

    # Get recent logs (last 200 lines for context)
    RECENT_LOGS=$(tail -n 200 "$LOG_FILE")
    
    # Critical failure patterns
    STUCK_LOOP=$(echo "$RECENT_LOGS" | grep -c "Loop protection triggered")
    EPERM_ERRORS=$(echo "$RECENT_LOGS" | grep -c "EPERM")
    TIMEOUT_FAILURES=$(echo "$RECENT_LOGS" | grep -c "exceeded maximum response time")
    CONTRACT_ERRORS=$(echo "$RECENT_LOGS" | grep -c "Error happened while trying to execute a function inside a smart contract")
    UNHANDLED_ERRORS=$(echo "$RECENT_LOGS" | grep -c "UnhandledPromiseRejection")
    MEMORY_LEAKS=$(echo "$RECENT_LOGS" | grep -c "JavaScript heap out of memory")
    
    # Detect if same request is being retried repeatedly (stuck claim loop)
    REPEATED_CLAIMS=$(echo "$RECENT_LOGS" | grep "Claimed via Control API" | tail -n 10 | awk '{print $NF}' | sort | uniq -c | awk '$1 > 3 {print $1}')
    
    # Detect recognition phase mimicry (claims dispatched without tool calls)
    MIMICRY_PATTERN=$(echo "$RECENT_LOGS" | grep -E "(Dispatched|dispatch_new_job)" | tail -n 50)
    DISPATCH_CLAIMS=$(echo "$MIMICRY_PATTERN" | grep -i "dispatched" | wc -l)
    DISPATCH_CALLS=$(echo "$MIMICRY_PATTERN" | grep "dispatch_new_job" | wc -l)
    
    KILL_REASON=""
    
    # Check for critical conditions
    if [ "$STUCK_LOOP" -gt 5 ]; then
        KILL_REASON="Loop protection triggered $STUCK_LOOP times (repetitive output detected)"
    elif [ "$EPERM_ERRORS" -gt 10 ]; then
        KILL_REASON="$EPERM_ERRORS EPERM errors (Gemini CLI cache issue - needs cleanup)"
    elif [ "$TIMEOUT_FAILURES" -gt 3 ]; then
        KILL_REASON="$TIMEOUT_FAILURES timeout failures (jobs exceeding 5-minute limit)"
    elif [ "$UNHANDLED_ERRORS" -gt 2 ]; then
        KILL_REASON="$UNHANDLED_ERRORS unhandled promise rejections (worker crash imminent)"
    elif [ "$MEMORY_LEAKS" -gt 0 ]; then
        KILL_REASON="JavaScript heap out of memory (memory leak detected)"
    elif [ -n "$REPEATED_CLAIMS" ]; then
        KILL_REASON="Same request claimed $REPEATED_CLAIMS times (stuck in claim loop)"
    elif [ "$DISPATCH_CLAIMS" -gt 5 ] && [ "$DISPATCH_CALLS" -eq 0 ]; then
        KILL_REASON="Recognition mimicry detected ($DISPATCH_CLAIMS dispatch claims, 0 actual calls)"
    fi
    
    if [ -n "$KILL_REASON" ]; then
        echo "[$(date)] CRITICAL FAILURE DETECTED: $KILL_REASON"
        echo "Recent error context:"
        echo "$RECENT_LOGS" | tail -n 50
        echo "---"
        
        # Find and kill mech worker processes
        PIDS=$(ps aux | grep -E "(mech_worker\.ts|tsx worker/mech_worker)" | grep -v grep | awk '{print $2}')
        
        if [ -n "$PIDS" ]; then
            echo "Killing worker processes: $PIDS"
            echo "$PIDS" | xargs kill -9
            echo "[$(date)] Worker killed. Manual restart required."
            echo "Recovery steps:"
            echo "  1. Check error logs above"
            echo "  2. If EPERM: ./scripts/clear-gemini-chat-cache.sh"
            echo "  3. If stuck loop: Review recognition learnings (may need cleanup)"
            echo "  4. If timeout: Break job into smaller sub-jobs"
            echo "  5. Restart: yarn dev:mech --workstream=<id>"
            exit 1
        else
            echo "No worker processes found (may have already crashed)"
        fi
    else
        # Report health metrics
        echo "[$(date)] Worker health check: OK"
        [ "$CONTRACT_ERRORS" -gt 0 ] && echo "  - $CONTRACT_ERRORS contract errors (warning, not critical)"
        [ "$TIMEOUT_FAILURES" -gt 0 ] && echo "  - $TIMEOUT_FAILURES timeout failures (warning)"
        [ "$STUCK_LOOP" -gt 0 ] && echo "  - $STUCK_LOOP loop protection triggers (warning)"
    fi
}

# Main monitoring loop
while true; do
    check_and_kill
    sleep "$CHECK_INTERVAL"
done

