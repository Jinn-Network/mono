#!/usr/bin/env python3
"""
Deploy Service #165 - Complete the deployment that timed out during mech registration.

This script uses the middleware's ServiceManager directly to:
1. Build the Docker deployment
2. Start the service containers
3. The mech registration will complete automatically when the service starts
"""

import os
import sys
from pathlib import Path

# Add middleware to path
middleware_path = Path(__file__).parent.parent / "olas-operate-middleware"
sys.path.insert(0, str(middleware_path))

from operate.cli import OperateApp

SERVICE_CONFIG_ID = "sc-b3aaf73c-78fe-4b28-98ef-6cf8730d04a1"
PASSWORD = os.environ.get("OPERATE_PASSWORD", "12345678")
BASE_RPC = os.environ.get("BASE_LEDGER_RPC", "https://base.publicnode.com")

def main():
    print("🚀 Deploying Service #165")
    print(f"Service Config ID: {SERVICE_CONFIG_ID}\n")
    
    # Set up operate environment
    home_path = middleware_path / ".operate"
    
    # Initialize operate app
    operate = OperateApp(home=home_path)
    operate.password = PASSWORD
    
    # Create service manager
    manager = operate.service_manager()
    
    # Load the service
    print("📋 Loading service configuration...")
    service = manager.load(service_config_id=SERVICE_CONFIG_ID)
    print(f"✅ Loaded service: {service.name}")
    print(f"   Chain: {service.home_chain}")
    print(f"   Safe: {service.chain_configs[service.home_chain].chain_data.multisig}\n")
    
    # Deploy the service locally (build + start Docker containers)
    print("📋 Building and starting Docker containers...")
    print("⏳ This may take a few minutes...\n")
    
    try:
        deployment = manager.deploy_service_locally(
            service_config_id=SERVICE_CONFIG_ID,
            use_docker=True,
            use_kubernetes=False,
            build_only=False  # Build AND start
        )
        
        print("✅ Service deployed successfully!")
        print(f"   Status: {deployment.status}")
        print(f"   Path: {deployment.path}\n")
        
        # The mech registration should happen automatically now
        print("📋 Mech registration will complete automatically as the service starts.")
        print("   Monitor Docker logs to see the registration transaction:\n")
        print(f"   docker logs {SERVICE_CONFIG_ID}_abci_0 -f\n")
        
    except Exception as e:
        print(f"❌ Error deploying service: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    print("\n" + "="*70)
    print("📋 DEPLOYMENT COMPLETE")
    print("="*70)
    print(f"Service Config ID: {SERVICE_CONFIG_ID}")
    print(f"Status: {deployment.status}")
    print("\nThe service is now running in Docker containers.")
    print("The mech should register itself automatically.")
    print("="*70 + "\n")

if __name__ == "__main__":
    main()

