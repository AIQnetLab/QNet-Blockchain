"""
Visualization of 1DEV Burn Model with Round Numbers
"""

from onedev_burn_model import OneDEVBurnCalculator, NodeType

def format_number(num):
    """Format number with thousands separator"""
    return f"{int(num):,}"

def main():
    calculator = OneDEVBurnCalculator()
    
    # Test points for visualization
    test_points = [
        (0, "Start"),
        (0.05, "5%"),
        (0.10, "10%"),
        (0.20, "20%"),
        (0.30, "30%"),
        (0.40, "40%"),
        (0.50, "50%"),
        (0.60, "60%"),
        (0.70, "70%"),
        (0.80, "80%"),
        (0.85, "85%"),
        (0.89, "89%"),
        (0.90, "90% - Transition")
    ]
    
    print("=" * 80)
    print("1DEV BURN MODEL - ACTIVATION PRICES")
    print("=" * 80)
    print("\nStarting prices (Universal - ALL node types):")
    print(f"  Light Node:  1,500 1DEV")
    print(f"  Full Node:   1,500 1DEV")
    print(f"  Super Node:  1,500 1DEV")
    print("\nMinimum prices (floor):")
    print(f"  Light Node:    150 1DEV")
    print(f"  Full Node:     150 1DEV")
    print(f"  Super Node:    150 1DEV")
    print("\n" + "-" * 80)
    print(f"{'Burned':<12} {'Percent':<8} {'Light':<12} {'Full':<12} {'Super':<12} {'Note'}")
    print("-" * 80)
    
    for ratio, label in test_points:
        burned = ratio * 1_000_000_000  # 1 billion 1DEV total supply
        
        # Get prices for each node type
        light_req = calculator.calculate_burn_requirement(NodeType.LIGHT, burned)
        full_req = calculator.calculate_burn_requirement(NodeType.FULL, burned)
        super_req = calculator.calculate_burn_requirement(NodeType.SUPER, burned)
        
        # Format output
        burned_str = f"{burned/1_000_000:.0f}M" if burned >= 1_000_000 else f"{burned/1_000:.0f}K"
        
        note = ""
        if ratio == 0:
            note = "← Network launch"
        elif ratio == 0.5:
            note = "← Halfway point"
        elif ratio == 0.85:
            note = "← Late stage"
        elif ratio >= 0.9:
            note = "← Transition to QNC"
        
        print(f"{burned_str:<12} {label:<8} "
              f"{format_number(light_req['amount']):<12} "
              f"{format_number(full_req['amount']):<12} "
              f"{format_number(super_req['amount']):<12} {note}")
    
    print("-" * 80)
    
    # Calculate savings examples
    print("\n" + "=" * 80)
    print("SAVINGS FOR DIFFERENT ENTRY POINTS")
    print("=" * 80)
    
    entry_points = [
        (0.10, "Early adopter (10% burned)"),
        (0.30, "Early majority (30% burned)"),
        (0.50, "Mid-stage (50% burned)"),
        (0.70, "Late majority (70% burned)"),
        (0.85, "Late stage (85% burned)")
    ]
    
    # Get initial prices
    initial_light = calculator.calculate_burn_requirement(NodeType.LIGHT, 0)['amount']
    initial_full = calculator.calculate_burn_requirement(NodeType.FULL, 0)['amount']
    initial_super = calculator.calculate_burn_requirement(NodeType.SUPER, 0)['amount']
    
    for ratio, description in entry_points:
        burned = ratio * 1_000_000_000
        
        light_price = calculator.calculate_burn_requirement(NodeType.LIGHT, burned)['amount']
        full_price = calculator.calculate_burn_requirement(NodeType.FULL, burned)['amount']
        super_price = calculator.calculate_burn_requirement(NodeType.SUPER, burned)['amount']
        
        light_savings = ((initial_light - light_price) / initial_light) * 100
        full_savings = ((initial_full - full_price) / initial_full) * 100
        super_savings = ((initial_super - super_price) / initial_super) * 100
        
        print(f"\n{description}:")
        print(f"  Light: {format_number(light_price)} 1DEV (save {light_savings:.0f}%)")
        print(f"  Full:  {format_number(full_price)} 1DEV (save {full_savings:.0f}%)")
        print(f"  Super: {format_number(super_price)} 1DEV (save {super_savings:.0f}%)")
    
    # Whitelist benefits
    print("\n" + "=" * 80)
    print("GENESIS NETWORK BOOTSTRAP")
    print("=" * 80)
    print("\nGenesis Validators (4 nodes for redundancy):")
    print("  - Node 1: Primary validator (free activation)")
    print("  - Node 2: Secondary validator (free activation)")
    print("  - Node 3: Backup validator 1 (free activation)")
    print("  - Node 4: Backup validator 2 (free activation)")
    print("\nAll other participants:")
    print("  - Pay full price according to burn progress")
    print("  - No discounts or special privileges")
    print("  - Fair and equal access for everyone")

if __name__ == "__main__":
    main() 