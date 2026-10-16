// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Axiomon (AXN) : cryptomonnaie pédagogique (token ERC-20)
/// @notice Offre plafonnée à 21 000 000 AXN et montant maximal par transfert.
contract Axiomon is ERC20, ERC20Burnable, ERC20Capped, Ownable {
    uint256 public constant MAX_SUPPLY = 21_000_000 * 10 ** 18;

    /// Montant maximal autorisé par transfert (modifiable par le propriétaire)
    uint256 public maxTransferAmount = 10_000 * 10 ** 18;

    error TransferLimitExceeded(uint256 amount, uint256 limit);

    event MaxTransferAmountChanged(uint256 newLimit);

    constructor(uint256 initialSupply)
        ERC20("Axiomon", "AXN")
        ERC20Capped(MAX_SUPPLY)
        Ownable(msg.sender)
    {
        _mint(msg.sender, initialSupply * 10 ** 18);
    }

    /// Création de nouveaux AXN (propriétaire uniquement, dans la limite du plafond)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// Le propriétaire peut modifier la limite (en unités de base, 18 décimales)
    function setMaxTransferAmount(uint256 newLimit) external onlyOwner {
        maxTransferAmount = newLimit;
        emit MaxTransferAmountChanged(newLimit);
    }

    // La limite s'applique aux transferts entre comptes, pas au mint ni au burn
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Capped)
    {
        if (from != address(0) && to != address(0) && value > maxTransferAmount) {
            revert TransferLimitExceeded(value, maxTransferAmount);
        }
        super._update(from, to, value);
    }
}
