import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader
from pathlib import Path
from dataset import TruckPackingDataset
from model import TruckPackingModel

def train_model():
    # 1. Hyperparameters & Setup
    epochs = 5
    batch_size = 32
    learning_rate = 0.001
    
    csv_path = Path("../sandbox/out/dataset/train.csv")
    if not csv_path.exists():
        print(f"Error: Could not find dataset at {csv_path.resolve()}.")
        return

    print("Initializing dataset and data loader...")
    dataset = TruckPackingDataset(csv_path)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
    
    print("Initializing model, loss function, and optimizer...")
    model = TruckPackingModel()
    
    # Mean Squared Error Loss since we are predicting continuous coordinates and dimensions
    criterion = nn.MSELoss()
    optimizer = optim.Adam(model.parameters(), lr=learning_rate)
    
    # 2. Training Loop
    model.train()
    print(f"\nStarting training for {epochs} epochs...")
    
    for epoch in range(epochs):
        epoch_loss = 0.0
        batch_count = 0
        
        for batch in loader:
            context = batch['context']
            current_box = batch['current_box']
            targets = batch['target']
            
            # Zero out gradients
            optimizer.zero_grad()
            
            # Forward pass: predict coordinates and sizes
            predictions = model(context, current_box)
            
            # Compute loss
            loss = criterion(predictions, targets)
            
            # Backward pass & optimize
            loss.backward()
            optimizer.step()
            
            epoch_loss += loss.item()
            batch_count += 1
            
        avg_loss = epoch_loss / batch_count
        print(f"Epoch [{epoch+1}/{epochs}] - Loss: {avg_loss:.4f}")
        
    print("\nTraining complete!")
    
    # 3. Save the trained model weights
    output_dir = Path("./weights")
    output_dir.mkdir(exist_ok=True)
    torch.save(model.state_dict(), output_dir / "truck_model.pth")
    print(f"Model weights saved successfully to {output_dir.resolve() / 'truck_model.pth'}")

if __name__ == "__main__":
    train_model()