'use strict';

const { createTeamManagementService } = require('../services/teamManagementService');
const { createEquipmentRepairService } = require('../services/equipmentRepairService');

const equipmentRepairService = createEquipmentRepairService();
const teamManagementService = createTeamManagementService({
  repairTodoSynchronizer: equipmentRepairService.syncOpenRepairMessages
});

exports.listMembers = async (req, res, next) => {
  try {
    const result = await teamManagementService.listMembers({
      authContext: req.authContext,
      filters: req.query
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

exports.createMember = async (req, res, next) => {
  try {
    const result = await teamManagementService.createMember({
      authContext: req.authContext,
      req,
      input: req.body || {}
    });
    return res.status(201).json({
      message: 'Team member created',
      ...result
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateMember = async (req, res, next) => {
  try {
    const member = await teamManagementService.updateMember({
      authContext: req.authContext,
      req,
      membershipId: req.params.membershipId,
      input: req.body || {}
    });
    return res.json({
      message: 'Team member updated',
      member
    });
  } catch (error) {
    return next(error);
  }
};

exports.disableMember = async (req, res, next) => {
  try {
    const member = await teamManagementService.disableMember({
      authContext: req.authContext,
      req,
      membershipId: req.params.membershipId,
      reason: req.body?.reason || null
    });
    return res.json({
      message: 'Team member disabled',
      member
    });
  } catch (error) {
    return next(error);
  }
};
